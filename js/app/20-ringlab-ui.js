"use strict";
// V.80.1: «Лаборатория звонка» — ЕДИНСТВЕННЫЙ вход: строка в Отладке (#ringlab-btn). Внутри: мастер «Сделай чтобы звонило», эксперименты
// с PASS/FAIL/NOTES (журнал локально, экспорт текстом), режим ожидания, «Микрофон в фоне», «Позвонить громко» (локальные
// телефон/FaceTime-ссылка контакта). Тексты RU/EN (как в devicecheck.js). Ничего не включено в реальные звонки по умолчанию.
// Честно: что реально происходит на iPhone, этот код проверить не может — результат фиксирует пользователь на устройстве.
const RingLab = (() => {
  const C = RingLabCore;
  const RU = {
    btn: "Лаборатория звонка", title: "Лаборатория звонка", intro: "Эксперименты для iPhone: что реально будит и звонит. Результаты (PASS/FAIL/заметки) хранятся только на этом устройстве, их можно выгрузить текстом.",
    close: "Закрыть", run: "Запустить", pass: "PASS", fail: "FAIL", note: "Заметка", noteAdd: "Записать заметку", noteHint: "Заметка к результату (необязательно)", wizard: "Мастер «Сделай чтобы звонило»",
    export: "Копировать журнал", download: "Скачать .txt", share: "Отправить", clear: "Очистить журнал", copied: "Скопировано", empty: "Журнал пуст", logTitle: "Журнал",
    wizTitle: "Сделай чтобы звонило", wizIntro: "Пошагово для iPhone. Отметьте, что сделали; в конце — проверка пуш-звонком.",
    wizSteps: ["Настройки iPhone → Уведомления → Эфир: «Допуск уведомлений» включён.", "Там же: «Звуки» включены; «Экран блокировки» и «Баннеры» включены.", "Фокусирование (Не беспокоить, Сон и т. д.): добавьте приложение в список разрешённых.", "Переключатель «Звонок/Бесшумно» (сбоку): в режиме «Бесшумно» уведомления и обычные звонки молчат. Только «Экстренный обход» и будильники звучат всегда.", "Хотите громкий звонок iMessage/звонок телефона от конкретного человека: в «Контактах» iPhone откройте контакт → Изменить → Рингтон/Звук сообщения → «Экстренный обход». Это настройка iOS, приложение её не меняет.", "Приложение добавлено на экран «Домой» и открыто оттуда (на iPhone push работает только так)."],
    wizTest: "Проверить пуш-звонок", wizTestHint: "Нажмите и сразу заблокируйте экран. Должно прийти уведомление «звонит».", wizOk: "Пуш дошёл за {n} с. Если вы его не услышали — смотрите пункты про звук, Фокус и «Бесшумно».", wizFail: "Пуш не дошёл за 15 с. Проверьте разрешение, установку на «Домой» и подписку (Отладка → Проверка уведомлений).", wizRun: "Идёт проверка…",
    wizHonest: "Честно: громкость и сигнал уведомления задаёт iOS, не приложение. Свёрнутое приложение само звонить не может.",
    e1: "1. Обычный пуш-звонок (raw)", e1d: "Сервер шлёт 3 «гудка» на это устройство. Заблокируйте экран. PASS — уведомление пришло и прозвучало.",
    e2: "2. Гибридный пуш-звонок (declarative, mutable)", e2d: "То же в формате Declarative Web Push. Нужен сервер с этим режимом; на старых iOS платформа может его не понять.",
    e3: "3. Режим ожидания (тихий аудио-цикл + Media Session)", e3d: "Запустите, сверните приложение, затем из другого устройства/эксперимента 1 отправьте тест-звонок. PASS — рингтон слышен при свёрнутом приложении. Расходует батарею.",
    e4: "4. Громкая ссылка (iMessage/SMS)", e4d: "Создаёт ссылку-звонок и открывает Сообщения с готовым текстом. PASS — сообщение пришло и звук был громким.",
    e5: "5. Ссылка FaceTime (эксперимент)", e5d: "Откроет сохранённую у контакта ссылку FaceTime. Эксперимент: Apple не гарантирует поведение.",
    e6: "6. Аудиосессия и AudioContext", e6d: "Отчёт: navigator.audioSession.type, состояние AudioContext. Переключатель «Бесшумно» может заглушать Web Audio.",
    e7: "7. Уведомления: разрешение и состояние", e7d: "Отчёт по разрешению, подписке, service worker.",
    e8: "8. Календарь: тест-звонок по расписанию (.ics)", e8d: "Файл с будильниками за 5 минут и в момент звонка (обычно звучат даже при «Бесшумно» — это проверка). Ссылка живёт ~10 минут, поэтому звонок назначен на +8 мин.",
    e9: "9. Отчёт об устройстве", e9d: "Версия iOS, режим «Домой», поддержка push и declarative-push (признак, не гарантия).",
    mic: "Микрофон в фоне", micIntro: "Петля в этой странице: микрофон → соединение → приём. Нажмите «Запустить», сверните приложение на 15–30 секунд, говорите/шумите рядом, вернитесь. Покажем, шёл ли звук и что случилось с треком. В наушниках, иначе будет эхо.",
    micV: ["Базовый вариант (ничего лишнего)", "+ audioSession play-and-record + Media Session", "+ Картинка в картинке (PiP)", "+ блокировка засыпания экрана (Wake Lock)", "+ PiP с беззвучным видео"],
    micVideo: "Для варианта 3: видеозвонок (PiP на удалённом видео)", micRecover: "Автовосстановление (повторный getUserMedia + replaceTrack)", micFinish: "Закончить и показать отчёт", micPip: "Открыть PiP", micRunning: "Идёт… сверните приложение, затем вернитесь.",
    standbyTitle: "Режим ожидания звонка", standbyOn: "Включить режим ожидания", standbyOff: "Выключить режим ожидания", standbyMeta: "Ожидание звонка", standbyWarn: "Внимание: режим держит тихий звук и заметно расходует батарею. Включайте только для опыта. iOS всё равно может остановить страницу.", standbyAuto: "Включать режим ожидания при запуске (после первого касания)", standbyState: "Работает: {a} с, сокет: {w}, пауз/заморозок: {g}", wsOpen: "открыт", wsClosed: "закрыт", standbyRing: "Пришёл тест-звонок при {v} странице — слышен ли рингтон? Отметьте PASS/FAIL.", vis: "видимой", hid: "скрытой",
    help: "Опыты (не включаются сами)", helpLabel: "Помощь в звонках: аудиосессия + Media Session + Wake Lock (эксперимент)", autoLoud: "Через 12 с без «звонит у собеседника» предлагать «Позвонить громко» (эксперимент)",
    loudTitle: "Позвонить громко", loudBtn: "Позвонить громко (эксперимент)", loudPick: "Контакт", loudSms: "Написать в iMessage/SMS со ссылкой", loudTel: "Позвонить по телефону", loudFt: "Открыть ссылку FaceTime (эксперимент)", loudNone: "Нет контактов", loudHint: "iMessage/SMS и звонок проходят мимо нашего сервера. Номер и ссылка FaceTime хранятся только на этом устройстве.",
    fields: "Телефон и FaceTime контакта (только на этом устройстве)", phone: "Телефон (+7…)", ft: "Ссылка FaceTime (https://facetime.apple.com/join#…)", save: "Сохранить", saved: "Сохранено", pick: "Выбрать из Контактов", pickNo: "Выбор из Контактов в этом браузере не поддерживается (iPhone Safari его не имеет): введите номер вручную.", badFt: "Ссылка FaceTime должна начинаться с https://facetime.apple.com/",
    linkFail: "Не удалось создать ссылку-звонок", skip: "Не запускается автоматически", done: "Готово", started: "Запущено",
  };
  const EN = {
    btn: "Ring Lab", title: "Ring Lab", intro: "iPhone experiments: what really wakes and rings. Results (PASS/FAIL/notes) stay on this device and can be exported as text.",
    close: "Close", run: "Run", pass: "PASS", fail: "FAIL", note: "Note", noteAdd: "Save note", noteHint: "Note for the result (optional)", wizard: "\"Make it ring\" wizard",
    export: "Copy log", download: "Download .txt", share: "Share", clear: "Clear log", copied: "Copied", empty: "Log is empty", logTitle: "Log",
    wizTitle: "Make it ring", wizIntro: "Step by step for iPhone. Tick what you did; finish with a push-ring self-test.",
    wizSteps: ["iPhone Settings → Notifications → this app: Allow Notifications is on.", "Same place: Sounds on; Lock Screen and Banners on.", "Focus (Do Not Disturb, Sleep, …): add this app to the allowed apps.", "The Ring/Silent switch (side): in Silent mode notifications and ordinary calls are muted too. Only Emergency Bypass and alarms always sound.", "For a loud iMessage/phone call from a specific person: iPhone Contacts → the contact → Edit → Ringtone/Text Tone → Emergency Bypass. This is an iOS setting; the app cannot change it.", "The app is added to the Home Screen and opened from there (push works only that way on iPhone)."],
    wizTest: "Test push ring", wizTestHint: "Tap, then lock the screen at once. A \"calling\" notification should arrive.", wizOk: "Push arrived in {n} s. If you did not hear it, check the sound, Focus and Silent-switch steps.", wizFail: "No push within 15 s. Check permission, Home Screen install and subscription (Debug → Notification check).", wizRun: "Testing…",
    wizHonest: "Honest note: the volume and sound of a notification are decided by iOS, not by the app. A backgrounded app cannot ring by itself.",
    e1: "1. Classic push ring (raw)", e1d: "The server sends 3 ring pushes to this device. Lock the screen. PASS = the notification arrived and sounded.",
    e2: "2. Hybrid push ring (declarative, mutable)", e2d: "Same in Declarative Web Push format. Needs a server that supports it; older iOS may not understand it.",
    e3: "3. Standby mode (silent audio loop + Media Session)", e3d: "Start it, background the app, then send a test ring from another device/experiment 1. PASS = the ringtone is audible while backgrounded. Uses battery.",
    e4: "4. Loud link (iMessage/SMS)", e4d: "Creates a link-call and opens Messages with a prefilled text. PASS = the message arrived with a loud alert.",
    e5: "5. FaceTime link (experimental)", e5d: "Opens the FaceTime link saved for a contact. Experimental: Apple does not guarantee behaviour.",
    e6: "6. Audio session and AudioContext", e6d: "Report: navigator.audioSession.type, AudioContext state. The Silent switch may mute Web Audio.",
    e7: "7. Notifications: permission and state", e7d: "Report on permission, subscription, service worker.",
    e8: "8. Calendar: scheduled test call (.ics)", e8d: "File with alarms at 5 minutes before and at call time (often audible even on Silent — that is the test). The link lives ~10 minutes, so the call is set to +8 min.",
    e9: "9. Device report", e9d: "iOS version, Home Screen mode, push and declarative-push support (an indicator, not a guarantee).",
    mic: "Microphone in background", micIntro: "A loopback inside this page: microphone → connection → receive. Tap Run, background the app for 15–30 s, talk/make noise nearby, come back. We report whether audio flowed and what happened to the track. Use headphones, or you will get echo.",
    micV: ["Baseline (nothing extra)", "+ audioSession play-and-record + Media Session", "+ Picture-in-Picture (PiP)", "+ Screen Wake Lock", "+ PiP with a silent video"],
    micVideo: "For variant 3: video call (PiP on the remote video)", micRecover: "Auto-recovery (getUserMedia again + replaceTrack)", micFinish: "Finish and show report", micPip: "Open PiP", micRunning: "Running… background the app, then come back.",
    standbyTitle: "Call standby mode", standbyOn: "Start standby mode", standbyOff: "Stop standby mode", standbyMeta: "Waiting for a call", standbyWarn: "Warning: this mode keeps a silent audio loop running and noticeably drains the battery. Use it only for the experiment. iOS may still suspend the page.", standbyAuto: "Start standby on launch (after the first tap)", standbyState: "Alive: {a} s, socket: {w}, pauses/freezes: {g}", wsOpen: "open", wsClosed: "closed", standbyRing: "A test ring arrived while the page was {v} — was the ringtone audible? Mark PASS/FAIL.", vis: "visible", hid: "hidden",
    help: "Experiments (never on by themselves)", helpLabel: "Call help: audio session + Media Session + Wake Lock (experimental)", autoLoud: "After 12 s without \"ringing on their phone\" offer \"Ring loudly\" (experimental)",
    loudTitle: "Ring loudly", loudBtn: "Ring loudly (experimental)", loudPick: "Contact", loudSms: "Message via iMessage/SMS with the link", loudTel: "Phone call", loudFt: "Open FaceTime link (experimental)", loudNone: "No contacts", loudHint: "iMessage/SMS and phone calls bypass our server. The number and FaceTime link are stored only on this device.",
    fields: "Contact phone and FaceTime (this device only)", phone: "Phone (+1…)", ft: "FaceTime link (https://facetime.apple.com/join#…)", save: "Save", saved: "Saved", pick: "Pick from Contacts", pickNo: "Contact Picker is not supported in this browser (iPhone Safari has none): type the number.", badFt: "A FaceTime link must start with https://facetime.apple.com/",
    linkFail: "Could not create the link-call", skip: "Does not start automatically", done: "Done", started: "Started",
  };
  const L = () => { let l = "en"; try { l = (document.documentElement.getAttribute("lang") || "en").slice(0, 2); } catch (e) {} return l === "ru" ? RU : EN; };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const btn = (label, cls, fn) => { const b = el("button", cls || "btn-secondary", label); b.type = "button"; if (fn) b.addEventListener("click", fn); return b; };
  const isIOS = () => C.parseUA(navigator.userAgent).ios;
  const FLAG = { standbyAuto: "ether.ringlab.standbyAuto", autoLoud: "ether.ringlab.autoLoud", callHelp: "ether.ringlab.callHelp" };
  const flag = (k) => C.lsGet(FLAG[k]) === "1";
  const setFlag = (k, on) => C.lsSet(FLAG[k], on ? "1" : "0");

  function mkSheet(id, title, hint) {
    const old = document.getElementById(id); if (old) old.remove();
    const sheet = el("div", "sheet"), panel = el("div", "sheet-panel glass-content"), back = el("div", "sheet-backdrop");
    sheet.id = id; sheet.append(back, panel);
    panel.append(el("div", "sheet-handle"), el("h2", "", title));
    if (hint) panel.appendChild(el("p", "fine", hint));
    document.body.appendChild(sheet);
    const close = () => sheet.remove();
    back.addEventListener("click", close);
    panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", title);
    return { sheet, panel, close };
  }

  // ---------- отчёты ----------
  function deviceReport() {
    const ua = C.parseUA(navigator.userAgent), t = [];
    t.push("ios: " + (ua.ios ? "yes " + (ua.version || "?") : "no"));
    let st = false; try { st = typeof isStandalone === "function" ? isStandalone() : !!(navigator.standalone || (matchMedia && matchMedia("(display-mode: standalone)").matches)); } catch (e) {}
    t.push("standalone(Home Screen): " + (st ? "yes" : "no"));
    t.push("serviceWorker: " + ("serviceWorker" in navigator) + ", PushManager: " + ("PushManager" in window) + ", Notification: " + (typeof Notification !== "undefined"));
    t.push("declarative push indicator (window.pushManager): " + (("pushManager" in window) ? "present (unverified)" : "absent"));
    t.push("Contact Picker: " + (!!(navigator.contacts && navigator.contacts.select)) + ", Media Session: " + ("mediaSession" in navigator) + ", WakeLock: " + ("wakeLock" in navigator) + ", PiP: " + (!!document.pictureInPictureEnabled));
    t.push("UA: " + String(navigator.userAgent).slice(0, 160));
    return t.join("\n");
  }
  function audioReport() {
    const t = [];
    t.push("navigator.audioSession: " + (navigator.audioSession ? "type=" + navigator.audioSession.type + (navigator.audioSession.state ? ", state=" + navigator.audioSession.state : "") : "not available"));
    try { const Ctx = window.AudioContext || window.webkitAudioContext; if (Ctx) { const c = new Ctx(); t.push("AudioContext: state=" + c.state + ", sampleRate=" + c.sampleRate); try { c.close(); } catch (e) {} } else t.push("AudioContext: not available"); } catch (e) { t.push("AudioContext error: " + String(e)); }
    t.push("Silent switch: the page cannot read it. If a tone is silent only with the switch on Silent, Web Audio is muted by it; only <audio>/playback sessions may pass.");
    return t.join("\n");
  }
  async function notifReport() {
    const t = [];
    t.push("Notification.permission: " + (typeof Notification !== "undefined" ? Notification.permission : "n/a"));
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      t.push("service worker: " + (reg && reg.active ? "active" : "none"));
      const sub = reg && reg.pushManager ? await reg.pushManager.getSubscription() : null;
      t.push("push subscription: " + (sub ? "yes" : "no"));
    } catch (e) { t.push("sw/push error: " + String(e)); }
    return t.join("\n");
  }
  function headerLine() { return "app " + (typeof APP_VERSION !== "undefined" ? APP_VERSION : "?") + "\n" + deviceReport(); }

  // ---------- Позвонить громко ----------
  function contactList() {
    const out = [];
    try { for (const c of state.contacts.values()) if (c.managed && !c.isGroup && !c.ephemeral) out.push(c); } catch (e) {}
    return out;
  }
  async function loudLink(c) {
    if (typeof linkCallCreateAndShare !== "function") return null;
    const e = await linkCallCreateAndShare({ forId: c ? c.id : null, forName: c ? c.name : "", noShare: true });
    return e && e.text ? e.text : null;
  }
  function openLoud(contactId) {
    const t = L(); const { panel, close } = mkSheet("ringlab-loud-sheet", t.loudTitle, t.loudHint);
    const list = contactList();
    if (!list.length) { panel.appendChild(el("p", "fine", t.loudNone)); panel.appendChild(btn(t.close, "btn-tertiary", close)); return; }
    const sel = el("select", "settings-select");
    for (const c of list) { const o = el("option", "", c.name || c.id); o.value = c.id; sel.appendChild(o); }
    if (contactId) sel.value = contactId;
    const cur = () => state.contacts.get(sel.value);
    const row = el("div", "row-actions");
    const sms = btn(t.loudSms, "btn-primary", async () => {
      sms.disabled = true;
      const text = await loudLink(cur()); sms.disabled = false;
      if (!text) { toast(t.linkFail); C.logAdd("loud-sms", "NOTE", "link-call create failed"); return; }
      C.logAdd("loud-sms", "INFO", "sms link opened");
      location.href = C.smsLink(cur() && cur().phoneLocal, text, isIOS());
    });
    const tel = btn(t.loudTel, "btn-secondary", () => { const l = C.telLink(cur() && cur().phoneLocal); if (l) { C.logAdd("loud-tel", "INFO", "tel opened"); location.href = l; } });
    const ft = btn(t.loudFt, "btn-secondary", () => { const l = C.cleanFaceTimeLink(cur() && cur().ftLink); if (l) { C.logAdd("facetime", "INFO", "facetime link opened"); window.open(l, "_blank", "noopener"); } });
    const sync = () => { const c = cur(); tel.classList.toggle("hidden", !C.telLink(c && c.phoneLocal)); ft.classList.toggle("hidden", !C.cleanFaceTimeLink(c && c.ftLink)); };
    sel.addEventListener("change", sync); sync();
    row.append(sms, tel, ft);
    panel.append(el("label", "fine", t.loudPick), sel, row, btn(t.close, "btn-tertiary", close));
  }
  function contactFields(host) {
    const t = L(); host.appendChild(el("h3", "", t.fields));
    const list = contactList();
    if (!list.length) { host.appendChild(el("p", "fine muted", t.loudNone)); return; }
    const sel = el("select", "settings-select"); for (const c of list) { const o = el("option", "", c.name || c.id); o.value = c.id; sel.appendChild(o); }
    const ph = el("input", "search-input"); ph.type = "tel"; ph.placeholder = t.phone; ph.autocomplete = "off";
    const ft = el("input", "search-input"); ft.type = "url"; ft.placeholder = t.ft; ft.autocomplete = "off";
    const fill = () => { const c = state.contacts.get(sel.value) || {}; ph.value = c.phoneLocal || ""; ft.value = c.ftLink || ""; };
    sel.addEventListener("change", fill); fill();
    const row = el("div", "row-actions");
    row.appendChild(btn(t.save, "btn-secondary", () => {
      const c = state.contacts.get(sel.value); if (!c) return;
      const p = C.cleanPhone(ph.value), f = ft.value.trim() ? C.cleanFaceTimeLink(ft.value) : "";
      if (ft.value.trim() && !f) { toast(t.badFt); return; }
      if (p) c.phoneLocal = p; else delete c.phoneLocal;
      if (f) c.ftLink = f; else delete c.ftLink;
      try { persistContacts(); } catch (e) {}
      toast(t.saved);
    }));
    const pickBtn = btn(t.pick, "btn-secondary", async () => {
      if (!(navigator.contacts && navigator.contacts.select)) { toast(t.pickNo); return; }
      try { const r = await navigator.contacts.select(["tel"], { multiple: false }); if (r && r[0] && r[0].tel && r[0].tel[0]) ph.value = r[0].tel[0]; } catch (e) {}
    });
    row.appendChild(pickBtn);
    host.append(sel, ph, ft, row);
  }

  // ---------- режим ожидания ----------
  const standby = { on: false, audio: null, timer: null, t0: 0, last: 0, gaps: 0, line: null, ringHook: null };
  function silentWavUri() { // 1 с, 8 кГц, 8 бит, тишина (0x80)
    const n = 8000, h = new Uint8Array(44 + n), dv = new DataView(h.buffer);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) h[o + i] = s.charCodeAt(i); };
    w(0, "RIFF"); dv.setUint32(4, 36 + n, true); w(8, "WAVE"); w(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, 8000, true); dv.setUint32(28, 8000, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true); w(36, "data"); dv.setUint32(40, n, true);
    h.fill(0x80, 44);
    let s = ""; for (let i = 0; i < h.length; i++) s += String.fromCharCode(h[i]);
    return "data:audio/wav;base64," + btoa(s);
  }
  function wsText() { const t = L(); let ok = false; try { ok = !!(signaling && signaling.connected); } catch (e) {} return ok ? t.wsOpen : t.wsClosed; }
  function standbyStart() {
    if (standby.on) return true;
    const t = L();
    const a = new Audio(silentWavUri()); a.loop = true; a.setAttribute("playsinline", ""); a.volume = 0.01;
    standby.audio = a;
    const p = a.play(); if (p && p.catch) p.catch(() => { C.logAdd("standby", "NOTE", "play() rejected (needs a tap)"); });
    try {
      if ("mediaSession" in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({ title: t.standbyMeta, artist: "Ether" });
        navigator.mediaSession.playbackState = "playing";
        for (const act of ["play", "pause"]) { try { navigator.mediaSession.setActionHandler(act, () => { try { a.play(); } catch (e) {} }); } catch (e) {} }
      }
    } catch (e) {}
    standby.on = true; standby.t0 = Date.now(); standby.last = Date.now(); standby.gaps = 0;
    standby.timer = setInterval(() => {
      const now = Date.now(); if (now - standby.last > 3500) standby.gaps++; standby.last = now;
      if (a.paused) { try { a.play(); } catch (e) {} }
      if (standby.line) standby.line.textContent = t.standbyState.replace("{a}", String(Math.round((now - standby.t0) / 1000))).replace("{w}", wsText()).replace("{g}", String(standby.gaps));
    }, 1000);
    C.logAdd("standby", "INFO", "started");
    return true;
  }
  function standbyStop() {
    if (!standby.on) return;
    clearInterval(standby.timer); standby.timer = null;
    try { standby.audio.pause(); } catch (e) {}
    standby.audio = null; standby.on = false;
    try { if ("mediaSession" in navigator) { navigator.mediaSession.playbackState = "none"; navigator.mediaSession.metadata = null; } } catch (e) {}
    C.logAdd("standby", "INFO", "stopped after " + Math.round((Date.now() - standby.t0) / 1000) + "s, gaps " + standby.gaps);
  }
  // пришёл тест-звонок (SW → ring-received): в режиме ожидания играем рингтон приложения
  function onRing() {
    if (!standby.on) return false;
    const hidden = document.visibilityState === "hidden";
    C.logAdd("standby-ring", "INFO", "ring arrived, page " + (hidden ? "hidden" : "visible"));
    try { if (typeof playRingtone === "function") { playRingtone(); setTimeout(() => { try { stopRingtone(); } catch (e) {} }, 8000); } } catch (e) {}
    try { toast(L().standbyRing.replace("{v}", hidden ? L().hid : L().vis)); } catch (e) {}
    return true;
  }
  function armStandbyAuto() {
    if (!flag("standbyAuto") || standby.on) return;
    const go = () => { document.removeEventListener("pointerup", go, true); if (flag("standbyAuto")) standbyStart(); };
    document.addEventListener("pointerup", go, true);
  }

  // ---------- микрофон в фоне ----------
  async function micRun(variant, o, hooks) {
    const S = { variant, t0: Date.now(), samples: [], vis: [], ev: [], recoveries: 0, stopped: false };
    const log = (m) => { S.ev.push(((Date.now() - S.t0) / 1000).toFixed(1) + "s " + m); if (hooks && hooks.onEvent) hooks.onEvent(m); };
    const cl = [];
    const wantVideo = !!(o.video && variant === 3);
    let stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: wantVideo });
    const pc1 = new RTCPeerConnection({ iceServers: [] }), pc2 = new RTCPeerConnection({ iceServers: [] });
    cl.push(() => { try { pc1.close(); pc2.close(); } catch (e) {} });
    pc1.onicecandidate = (e) => { if (e.candidate) pc2.addIceCandidate(e.candidate).catch(() => {}); };
    pc2.onicecandidate = (e) => { if (e.candidate) pc1.addIceCandidate(e.candidate).catch(() => {}); };
    let remote = null; const remoteP = new Promise((r) => { pc2.ontrack = (e) => { if (!remote) { remote = e.streams[0] || new MediaStream(); r(remote); } if (!e.streams[0]) remote.addTrack(e.track); }; });
    const senders = stream.getTracks().map((tr) => pc1.addTrack(tr, stream));
    const watchTrack = (tr) => {
      tr.addEventListener("mute", () => { log("track mute"); });
      tr.addEventListener("unmute", () => { log("track unmute"); if (o.recover) recover("unmute"); });
      tr.addEventListener("ended", () => { log("track ended"); if (o.recover) recover("ended"); });
    };
    stream.getAudioTracks().forEach(watchTrack);
    async function recover(why) {
      if (S.stopped || S.recovering) return;
      const tr = stream.getAudioTracks()[0];
      if (tr && tr.readyState === "live" && !tr.muted) return;
      S.recovering = true;
      try {
        const ns = await navigator.mediaDevices.getUserMedia({ audio: true });
        const nt = ns.getAudioTracks()[0];
        const snd = senders.find((s) => s.track && s.track.kind === "audio") || pc1.getSenders().find((s) => s.track == null || s.track.kind === "audio");
        if (snd) await snd.replaceTrack(nt);
        stream.getAudioTracks().forEach((x) => { try { x.stop(); } catch (e) {} });
        stream = new MediaStream([nt, ...stream.getVideoTracks()]); watchTrack(nt);
        S.recoveries++; log("recovered (" + why + "), would signal 'peer mic suspended' -> resumed");
      } catch (e) { log("recover failed: " + String(e && e.name || e)); }
      S.recovering = false;
    }
    const offer = await pc1.createOffer(); await pc1.setLocalDescription(offer); await pc2.setRemoteDescription(offer);
    const ans = await pc2.createAnswer(); await pc2.setLocalDescription(ans); await pc1.setRemoteDescription(ans);
    const rs = await Promise.race([remoteP, new Promise((r) => setTimeout(() => r(null), 5000))]);
    if (!rs) log("no remote stream within 5s");
    // воспроизведение удалённого потока: вариант 1 — бесшумный приёмник Web Audio (иначе статистика не растёт), 2+ — реальный <audio> (в наушники!)
    let sink = null;
    if (rs) {
      if (variant === 1) {
        try { const Ctx = window.AudioContext || window.webkitAudioContext, ac = new Ctx(), src = ac.createMediaStreamSource(rs), g = ac.createGain(); g.gain.value = 0; src.connect(g); g.connect(ac.destination); cl.push(() => { try { ac.close(); } catch (e) {} }); } catch (e) { log("silent sink failed: " + String(e)); }
      } else {
        sink = document.createElement("audio"); sink.srcObject = rs; sink.setAttribute("playsinline", ""); sink.autoplay = true; sink.style.display = "none"; document.body.appendChild(sink);
        cl.push(() => { try { sink.pause(); sink.srcObject = null; sink.remove(); } catch (e) {} });
        const p = sink.play(); if (p && p.catch) p.catch((e) => log("remote play() rejected: " + String(e && e.name)));
      }
    }
    if (variant >= 2 && variant !== 3.5) {
      try { if (navigator.audioSession) { navigator.audioSession.type = "play-and-record"; log("audioSession.type=play-and-record"); } else log("audioSession not available"); } catch (e) { log("audioSession error " + e); }
      try {
        if ("mediaSession" in navigator) {
          navigator.mediaSession.metadata = new MediaMetadata({ title: L().standbyMeta, artist: "Ether" });
          navigator.mediaSession.playbackState = "playing";
          if (navigator.mediaSession.setMicrophoneActive) navigator.mediaSession.setMicrophoneActive(true);
          if (navigator.mediaSession.setCameraActive && wantVideo) navigator.mediaSession.setCameraActive(true);
          log("mediaSession set (mic active: " + (typeof navigator.mediaSession.setMicrophoneActive) + ")");
          cl.push(() => { try { navigator.mediaSession.playbackState = "none"; navigator.mediaSession.metadata = null; if (navigator.mediaSession.setMicrophoneActive) navigator.mediaSession.setMicrophoneActive(false); } catch (e) {} });
        }
      } catch (e) { log("mediaSession error " + e); }
    }
    if (variant === 4) {
      try { if (navigator.wakeLock) { const wl = await navigator.wakeLock.request("screen"); log("wakeLock acquired"); cl.push(() => { try { wl.release(); } catch (e) {} }); } else log("wakeLock not available"); } catch (e) { log("wakeLock failed: " + String(e && e.name)); }
    }
    // PiP: 3 — удалённое видео (видеозвонок) или canvas+аудио удалённого потока; 5 — беззвучное видео из canvas
    S.pip = null;
    if ((variant === 3 || variant === 5) && rs) {
      const vid = document.createElement("video"); vid.setAttribute("playsinline", ""); vid.muted = variant === 5; vid.autoplay = true; vid.style.cssText = "width:120px;height:120px;border-radius:12px;background:#000";
      if (wantVideo) { vid.srcObject = rs; try { vid.autoPictureInPicture = true; vid.setAttribute("autopictureinpicture", ""); } catch (e) {} }
      else {
        const cv = document.createElement("canvas"); cv.width = cv.height = 240; const g = cv.getContext("2d");
        const draw = () => { g.fillStyle = "#222"; g.fillRect(0, 0, 240, 240); g.fillStyle = "#fff"; g.font = "bold 80px sans-serif"; g.textAlign = "center"; g.fillText("E", 120, 130); g.font = "28px sans-serif"; g.fillText(Math.floor((Date.now() - S.t0) / 1000) + " s", 120, 190); };
        draw(); const di = setInterval(draw, 500); cl.push(() => clearInterval(di));
        const cs = cv.captureStream ? cv.captureStream(5) : new MediaStream();
        if (variant === 3) rs.getAudioTracks().forEach((tr) => cs.addTrack(tr));
        vid.srcObject = cs;
      }
      S.videoEl = vid; cl.push(() => { try { if (document.pictureInPictureElement === vid) document.exitPictureInPicture(); vid.srcObject = null; vid.remove(); } catch (e) {} });
      const pv = vid.play(); if (pv && pv.catch) pv.catch((e) => log("video play() rejected: " + String(e && e.name)));
      S.pip = async () => { try { if (!vid.requestPictureInPicture) { log("PiP not available"); return false; } await vid.requestPictureInPicture(); log("PiP opened"); return true; } catch (e) { log("PiP failed: " + String(e && e.name || e)); return false; } };
    }
    const onVis = () => { const hidden = document.visibilityState === "hidden"; S.vis.push({ t: Date.now() - S.t0, hidden }); log("visibility " + (hidden ? "hidden" : "visible")); if (!hidden && o.recover) recover("visible"); };
    document.addEventListener("visibilitychange", onVis); cl.push(() => document.removeEventListener("visibilitychange", onVis));
    const tick = setInterval(async () => {
      try {
        const rep = await pc2.getStats(); let tsr = 0, tae = 0, lvl = 0;
        rep.forEach((r) => { if (r.type === "inbound-rtp" && (r.kind === "audio" || r.mediaType === "audio")) { tsr = r.totalSamplesReceived || 0; tae = r.totalAudioEnergy || 0; lvl = r.audioLevel || 0; } });
        S.samples.push({ t: Date.now() - S.t0, hidden: document.visibilityState === "hidden", tsr, tae, lvl });
      } catch (e) {}
    }, 1000);
    cl.push(() => clearInterval(tick));
    S.finish = () => {
      S.stopped = true; cl.forEach((f) => { try { f(); } catch (e) {} });
      try { stream.getTracks().forEach((x) => x.stop()); } catch (e) {}
      const a = C.analyseMic(S.samples, S.vis);
      const verdict = a.flowed === true ? "audio flowed while hidden" : a.flowed === false ? "NO audio while hidden (or silence)" : "inconclusive (stay hidden >= 2 s, make noise)";
      return "variant " + variant + (o.recover ? " +recover" : "") + ": " + verdict + "; hidden " + Math.round(a.hiddenMs / 1000) + "s; bg samples " + a.bgSamples + (a.note ? " (" + a.note + ")" : "") + "; dSamples " + a.dSamples + "; dEnergy " + a.dEnergy.toFixed(4) + "; recoveries " + S.recoveries + "\nevents: " + S.ev.join("; ");
    };
    return S;
  }
  // Опциональная помощь в реальном звонке (по флагу callHelp, по умолчанию выкл.): audioSession + Media Session + Wake Lock
  const callHelp = { wl: null, on: false };
  function callHelpStart() {
    if (!flag("callHelp") || callHelp.on) return;
    callHelp.on = true;
    try { if (navigator.audioSession) navigator.audioSession.type = "play-and-record"; } catch (e) {}
    try { if ("mediaSession" in navigator) { navigator.mediaSession.metadata = new MediaMetadata({ title: L().standbyMeta, artist: "Ether" }); navigator.mediaSession.playbackState = "playing"; if (navigator.mediaSession.setMicrophoneActive) navigator.mediaSession.setMicrophoneActive(true); } } catch (e) {}
    try { if (navigator.wakeLock) navigator.wakeLock.request("screen").then((w) => { if (callHelp.on) callHelp.wl = w; else w.release(); }).catch(() => {}); } catch (e) {}
  }
  function callHelpStop() {
    if (!callHelp.on) return; callHelp.on = false;
    try { if (callHelp.wl) callHelp.wl.release(); } catch (e) {} callHelp.wl = null;
    try { if ("mediaSession" in navigator) { navigator.mediaSession.playbackState = "none"; navigator.mediaSession.metadata = null; if (navigator.mediaSession.setMicrophoneActive) navigator.mediaSession.setMicrophoneActive(false); } } catch (e) {}
  }
  // хук из экрана звонка: через 12 с без «звонит у собеседника» (только если флаг в Отладке включён)
  function autoLoudHook(contactId) { if (flag("autoLoud")) { try { openLoud(contactId); } catch (e) {} } }

  // ---------- мастер ----------
  function openWizard() {
    const t = L(); const { panel, close } = mkSheet("ringlab-wizard-sheet", t.wizTitle, t.wizIntro);
    const KEY = "ether.ringlab.wiz"; let done = {}; try { done = JSON.parse(C.lsGet(KEY) || "{}") || {}; } catch (e) {}
    const ul = el("ul", "notifcheck-list");
    t.wizSteps.forEach((s, i) => {
      const li = el("li", ""), lab = el("label", "settings-row"), cb = el("input"); cb.type = "checkbox"; cb.className = "switch"; cb.checked = !!done[i];
      cb.addEventListener("change", () => { done[i] = cb.checked; C.lsSet(KEY, JSON.stringify(done)); });
      lab.append(el("span", "", (i + 1) + ". " + s), cb); li.appendChild(lab); ul.appendChild(li);
    });
    const res = el("p", "fine", ""); res.setAttribute("role", "status");
    const test = btn(t.wizTest, "btn-primary", async () => {
      test.disabled = true; res.textContent = t.wizRun;
      let r = { ok: false };
      try { r = typeof DeviceCheck !== "undefined" && DeviceCheck.runRingTest ? await DeviceCheck.runRingTest(15000) : { ok: false }; } catch (e) {}
      test.disabled = false;
      res.textContent = r.ok ? t.wizOk.replace("{n}", String(r.sec)) : t.wizFail;
      C.logAdd("wizard-selftest", r.ok ? "PASS" : "FAIL", r.ok ? "arrived in " + r.sec + "s" : (r.reason || "no push"));
    });
    panel.append(ul, el("p", "fine muted", t.wizTestHint), test, res, el("p", "fine muted", t.wizHonest), btn(t.close, "btn-tertiary", close));
  }

  // ---------- лаборатория ----------
  function openLab() {
    const t = L(); const { panel, close } = mkSheet("ringlab-sheet", t.title, t.intro);
    panel.appendChild(btn(t.wizard, "btn-primary", openWizard));
    const out = el("pre", "diag-log"); out.style.whiteSpace = "pre-wrap"; out.style.userSelect = "text";
    const noteIn = el("input", "search-input"); noteIn.type = "text"; noteIn.placeholder = t.noteHint;
    const logBox = el("pre", "diag-log"); logBox.style.whiteSpace = "pre-wrap"; logBox.style.userSelect = "text"; logBox.setAttribute("aria-live", "polite");
    const renderLog = () => { const e = C.logRead(); logBox.textContent = e.length ? C.exportText("", e.slice(-12)) : t.empty; };
    const mark = (id, res) => { C.logAdd(id, res, noteIn.value + (out.textContent ? " | " + out.textContent.slice(0, 600) : "")); noteIn.value = ""; renderLog(); };
    const exps = [];
    const addExp = (id, title, desc, run) => {
      const box = el("div", "settings-group flat-content"); box.dataset.exp = id;
      box.append(el("h3", "", title), el("p", "fine", desc));
      const row = el("div", "row-actions");
      if (run) row.appendChild(btn(t.run, "btn-secondary", async () => { out.textContent = "…"; box.after(out); let r = ""; try { r = await run(); } catch (e) { r = "error: " + String(e && e.message || e); } out.textContent = r || t.done; if (r) C.logAdd(id, "INFO", r.slice(0, 800)); renderLog(); }));
      row.append(btn(t.pass, "btn-secondary", () => mark(id, "PASS")), btn(t.fail, "btn-secondary", () => mark(id, "FAIL")), btn(t.noteAdd, "btn-tertiary", () => mark(id, "NOTE")));
      box.appendChild(row); panel.appendChild(box); exps.push(box);
      return box;
    };
    const ringTest = async (mode) => {
      if (typeof DeviceCheck === "undefined") return "DeviceCheck missing";
      const r = await DeviceCheck.runRingTest(15000, mode);
      return r.ok ? "push arrived in " + r.sec + "s (" + (mode || "raw") + ")" : "no push in 15s (" + (r.reason || "timeout") + ", " + (mode || "raw") + ")";
    };
    addExp("e1-raw", t.e1, t.e1d, () => ringTest());
    addExp("e2-hybrid", t.e2, t.e2d, () => ringTest("hybrid"));
    const e3 = addExp("e3-standby", t.e3, t.e3d, null);
    e3.append(el("p", "fine muted", t.standbyWarn));
    const line = el("p", "fine", ""); standby.line = line;
    const sbRow = el("div", "row-actions");
    const sbBtn = btn(standby.on ? t.standbyOff : t.standbyOn, "btn-secondary", () => { if (standby.on) standbyStop(); else standbyStart(); sbBtn.textContent = standby.on ? t.standbyOff : t.standbyOn; });
    sbRow.appendChild(sbBtn);
    const autoLab = el("label", "settings-row"), autoCb = el("input"); autoCb.type = "checkbox"; autoCb.className = "switch"; autoCb.checked = flag("standbyAuto");
    autoCb.addEventListener("change", () => setFlag("standbyAuto", autoCb.checked)); autoLab.append(el("span", "", t.standbyAuto), autoCb);
    e3.append(line, sbRow, autoLab);
    addExp("e4-loud-link", t.e4, t.e4d, null).querySelector(".row-actions").prepend(btn(t.loudBtn, "btn-secondary", () => openLoud()));
    addExp("e5-facetime", t.e5, t.e5d, null).querySelector(".row-actions").prepend(btn(t.loudBtn, "btn-secondary", () => openLoud()));
    addExp("e6-audio", t.e6, t.e6d, async () => audioReport());
    addExp("e7-notif", t.e7, t.e7d, notifReport);
    addExp("e8-ics", t.e8, t.e8d, async () => {
      const start = Date.now() + 8 * 60000;
      let url = location.origin + location.pathname;
      try { const link = await (async () => { const e = typeof linkCallCreateAndShare === "function" ? await linkCallCreateAndShare({ noShare: true }) : null; return e && e.link; })(); if (link) url = link; } catch (e) {}
      const ics = C.buildICS({ start, title: "Ether test call", url, description: "Ether test call", uid: "ringlab-" + start });
      const blob = new Blob([ics], { type: "text/calendar" }), a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = "ether-test-call.ics"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      return ".ics: alarms -5 min and at " + new Date(start).toLocaleTimeString() + (url.indexOf("#call=") >= 0 ? "; link-call URL included (valid ~10 min)" : "; no link-call (offline?) — app URL used");
    });
    addExp("e9-device", t.e9, t.e9d, async () => deviceReport());

    // микрофон в фоне
    const mbox = el("div", "settings-group flat-content"); mbox.append(el("h3", "", t.mic), el("p", "fine", t.micIntro));
    const vsel = el("select", "settings-select"); t.micV.forEach((n, i) => { const o = el("option", "", (i + 1) + ". " + n); o.value = String(i + 1); vsel.appendChild(o); });
    const vidLab = el("label", "settings-row"), vidCb = el("input"); vidCb.type = "checkbox"; vidCb.className = "switch"; vidLab.append(el("span", "", t.micVideo), vidCb);
    const recLab = el("label", "settings-row"), recCb = el("input"); recCb.type = "checkbox"; recCb.className = "switch"; recLab.append(el("span", "", t.micRecover), recCb);
    const mrow = el("div", "row-actions"), mstat = el("p", "fine", "");
    let cur = null;
    const mstart = btn(t.run, "btn-secondary", async () => {
      if (cur) return; mstat.textContent = t.micRunning;
      const variant = parseInt(vsel.value, 10);
      try {
        cur = await micRun(variant, { video: vidCb.checked, recover: recCb.checked }, { onEvent: (m) => { mstat.textContent = t.micRunning + " " + m; } });
        mfin.classList.remove("hidden");
        if (cur.pip) { mpip.classList.remove("hidden"); mbox.appendChild(cur.videoEl); }
      } catch (e) { mstat.textContent = "error: " + String(e && e.name || e); cur = null; }
    });
    const mpip = btn(t.micPip, "btn-secondary", () => { if (cur && cur.pip) cur.pip(); }); mpip.classList.add("hidden");
    const mfin = btn(t.micFinish, "btn-primary", () => { if (!cur) return; const r = cur.finish(); cur = null; mstat.textContent = r; out.textContent = r; C.logAdd("mic-bg-v" + vsel.value, "INFO", r.slice(0, 1200)); mfin.classList.add("hidden"); mpip.classList.add("hidden"); renderLog(); });
    mfin.classList.add("hidden");
    mrow.append(mstart, mpip, mfin, btn(t.pass, "btn-secondary", () => { C.logAdd("mic-bg-v" + vsel.value, "PASS", noteIn.value + " " + mstat.textContent.slice(0, 600)); renderLog(); }), btn(t.fail, "btn-secondary", () => { C.logAdd("mic-bg-v" + vsel.value, "FAIL", noteIn.value + " " + mstat.textContent.slice(0, 600)); renderLog(); }));
    mbox.append(vsel, vidLab, recLab, mrow, mstat); panel.appendChild(mbox);

    // опыты, не включаемые сами
    const hbox = el("div", "settings-group flat-content"); hbox.appendChild(el("h3", "", t.help));
    for (const [k, label] of [["callHelp", t.helpLabel], ["autoLoud", t.autoLoud]]) {
      const lab = el("label", "settings-row"), cb = el("input"); cb.type = "checkbox"; cb.className = "switch"; cb.checked = flag(k);
      cb.addEventListener("change", () => setFlag(k, cb.checked)); lab.append(el("span", "", label), cb); hbox.appendChild(lab);
    }
    panel.appendChild(hbox);
    const fbox = el("div", "settings-group flat-content"); contactFields(fbox); panel.appendChild(fbox);

    panel.append(noteIn, el("h3", "", t.logTitle), logBox);
    const lrow = el("div", "row-actions");
    const textNow = () => C.exportText(headerLine());
    lrow.append(
      btn(t.export, "btn-secondary", async () => { try { await navigator.clipboard.writeText(textNow()); toast(t.copied); } catch (e) { out.textContent = textNow(); } }),
      btn(t.download, "btn-secondary", () => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([textNow()], { type: "text/plain" })); a.download = "ether-ring-lab.txt"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000); }),
      btn(t.share, "btn-secondary", async () => { try { if (navigator.share) await navigator.share({ text: textNow() }); } catch (e) {} }),
      btn(t.clear, "btn-tertiary", () => { C.logClear(); renderLog(); })
    );
    panel.append(lrow, btn(t.close, "btn-tertiary", () => { standby.line = null; close(); }));
    renderLog();
    return { close };
  }

  function wire() {
    const b = document.getElementById("ringlab-btn"); if (!b || b.dataset.rlWired) return;
    b.dataset.rlWired = "1"; b.addEventListener("click", openLab);
    const relabel = () => { const s = b.querySelector("span"); if (s) s.textContent = L().btn; };
    relabel();
    try { if (typeof MutationObserver !== "undefined") new MutationObserver(relabel).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] }); } catch (e) {}
    armStandbyAuto();
  }
  if (typeof document !== "undefined") { if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire); else wire(); }
  return { wire, openLab, openWizard, openLoud, onRing, autoLoudHook, callHelpStart, callHelpStop, standbyStart, standbyStop, deviceReport, audioReport, flag, setFlag, micRun, isStandby: () => standby.on };
})();
