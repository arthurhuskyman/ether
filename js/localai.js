// =====================================================================
// Локальный ИИ: распознавание голосовых (Whisper-base в WebAssembly, transformers.js) и краткое содержание.
// Звук никуда не отправляется — модель выполняется на устройстве. Единственное обращение в сеть — разовая загрузка библиотеки
// (wasm-файлы onnxruntime с cdn.jsdelivr.net) и модели (huggingface.co, ≈40 МБ); поэтому функция включается только после явного согласия,
// а при загрузке эти серверы видят IP-адрес. Модель кэшируется браузером; удалить её можно в настройках.
// «Краткое содержание» — выжимка ключевых предложений без нейросети (работает сразу и без загрузок).
// Загружается после app.js; использует его глобалы (state, Store, IDB, T, toast, confirmSheet, persistContacts…).
// =====================================================================
const LocalAI = (() => {
  // Библиотека лежит на нашем origin (js/vendor/transformers.min.js, 743 КБ, Apache-2.0, версия 3.0.0): CSP не пускает чужие скрипты,
  // а import() из blob: у неё не работает (webpack считает publicPath через new URL("./", import.meta.url)). Подлинность файла
  // закреплена хэшем TF_SHA384 (его проверяет tests/infra-csp.test.js; обновление: openssl dgst -sha384 -binary <файл> | openssl base64 -A).
  // Из сети (HF CDN, jsdelivr) приходят только модель и wasm-файлы onnxruntime — это данные/код wasm, а не наш JS.
  const TF_URL = "js/vendor/transformers.min.js";
  const TF_SHA384 = "arMqFKceYrLR/J+5OXE+8jl9+A/ZR7C6u4byZI/THasUD9WZPB3sAz8/9KyKAMio";
  async function importLib() { return import(new URL(TF_URL, document.baseURI).href); }
  // whisper-base заметно точнее tiny на русском и коротких фразах (≈80 МБ в квантованном виде вместо ≈40)
  const MODEL = "Xenova/whisper-base";
  const FALLBACK_MODEL = "Xenova/whisper-tiny"; // если base не загрузилась или не стартовала
  const MAX_AUDIO_SEC = 300;
  const LANG_NAMES = { ru: "russian", en: "english", de: "german", fr: "french", es: "spanish", it: "italian", pt: "portuguese", uk: "ukrainian", pl: "polish", tr: "turkish", ar: "arabic", zh: "chinese", ja: "japanese", ko: "korean", hi: "hindi", nl: "dutch", cs: "czech", sv: "swedish", he: "hebrew", fa: "persian" };
  let engine = null, loading = null;
  const progressListeners = new Set();
  const notify = (p) => progressListeners.forEach((fn) => { try { fn(p); } catch (e) {} });

  // Подмена движка (тесты и возможные другие реализации): async (Float32Array, { language }) => string
  function setEngine(fn) { engine = fn; }
  function isReady() { return !!engine; }
  // Общий прогресс загрузки из событий по отдельным файлам модели: сумма байт, без откатов назад
  function makeProgress(emit) {
    const files = new Map(); let shown = 0;
    return (p) => {
      if (!p || !p.file) return;
      if (p.status === "done") { const f = files.get(p.file); if (f && f.total) f.loaded = f.total; }
      else if (p.status === "progress" || p.status === "initiate" || p.status === "download") {
        const f = files.get(p.file) || { loaded: 0, total: 0 }; files.set(p.file, f);
        if (typeof p.total === "number" && p.total > 0) f.total = p.total;
        if (typeof p.loaded === "number") f.loaded = Math.min(p.loaded, f.total || p.loaded);
      } else return;
      let loaded = 0, total = 0; for (const f of files.values()) { loaded += f.loaded; total += f.total; }
      if (total <= 0) return;
      shown = Math.max(shown, Math.min(99, (loaded / total) * 100)); emit(shown);
    };
  }
  // ---- Диагностика загрузки: этап, имя ошибки, http-коды, размер скачанного, окружение (без текстов и ссылок с токенами) ----
  const WASM_MIRRORS = [null, "https://unpkg.com/@huggingface/transformers@3.0.0/dist/"]; // null = путь по умолчанию (cdn.jsdelivr.net)
  const LOAD_PLAN = [
    { model: MODEL, dtype: "q8", mirror: 0, cache: true },
    { model: FALLBACK_MODEL, dtype: "q8", mirror: 0, cache: true },
    { model: FALLBACK_MODEL, dtype: "q8", mirror: 0, cache: false }, // без Cache API (Safari иногда не даёт писать в него)
  ];
  const STALL_MS = 90000; // нет ни одного байта прогресса столько — попытка считается зависшей
  let diag = null;
  function envInfo() {
    const o = {};
    try { o.coi = typeof crossOriginIsolated !== "undefined" ? !!crossOriginIsolated : null; } catch (e) {}
    try { o.sab = typeof SharedArrayBuffer !== "undefined"; } catch (e) {}
    try { o.webgpu = !!navigator.gpu; } catch (e) {}
    try { if (navigator.deviceMemory) o.memGB = navigator.deviceMemory; } catch (e) {}
    try { if (performance.memory) o.heapMB = Math.round(performance.memory.jsHeapSizeLimit / 1048576); } catch (e) {}
    try { o.cores = navigator.hardwareConcurrency; } catch (e) {}
    try { o.cache = typeof caches !== "undefined"; } catch (e) {}
    try { o.online = navigator.onLine; } catch (e) {}
    return o;
  }
  const cleanMsg = (m) => String(m || "").replace(/https?:\/\/([^\s/?#"')]+)[^\s"')]*/g, "$1").replace(/[A-Za-z0-9_\-]{32,}/g, "…").replace(/\s+/g, " ").slice(0, 200);
  // Подсказка по этапу/ошибке — что делать пользователю
  function hintFor(stage, name, msg, http) {
    const m = String(msg || "");
    if (/timeout|stall/i.test(m)) return "сеть слишком медленная или соединение оборвалось: повторите по Wi-Fi";
    if (stage === "lib") return "не загрузился js/vendor/transformers.min.js: обновите приложение (закройте и откройте его заново)";
    if (stage === "hash") return "файл библиотеки повреждён или устарел в кэше: обновите приложение";
    if (http && http.some((h) => h >= 400)) return "сервер модели/wasm ответил ошибкой (huggingface.co или cdn.jsdelivr.net недоступны или заблокированы сетью/блокировщиком)";
    if (/Failed to fetch|NetworkError|Load failed|fetching of the wasm failed|no available backend/i.test(m)) return "не удалось скачать wasm/модель: нет доступа к huggingface.co или cdn.jsdelivr.net (VPN, блокировщик, сеть)";
    if (/Content Security Policy|CSP|unsafe-eval|wasm.*compile|CompileError|LinkError/i.test(m + " " + name)) return "браузер запретил/не смог скомпилировать wasm (политика безопасности или старая версия iOS)";
    if (/memory|allocat|RangeError|out of/i.test(m + " " + name)) return "не хватило памяти: закройте другие приложения и вкладки и повторите";
    if (/QuotaExceeded|quota|Cache/i.test(m + " " + name)) return "нет места в хранилище для кэша модели: освободите место";
    if (stage === "decode") return "не удалось декодировать звук (Web Audio)";
    return "неизвестная ошибка этапа " + stage;
  }
  async function loadEngine() {
    if (engine) return engine;
    if (loading) return loading;
    loading = (async () => {
      const d = diag = { stage: "lib", attempts: [], env: envInfo(), bytes: 0, http: [], t0: Date.now() };
      let mod;
      try { mod = await importLib(); } catch (e) { d.stage = "lib"; d.error = { name: String(e && e.name || "Error"), msg: cleanMsg(e && e.message) }; d.hint = hintFor("lib", d.error.name, d.error.msg, d.http); throw tagged(e, d); }
      const progress0 = makeProgress(notify);
      let lastAct = Date.now(), lastErr = null;
      // onnxruntime запоминает неудачную инициализацию wasm в рамках страницы, поэтому хост wasm выбираем ДО первой попытки пробным запросом
      d.stage = "wasm"; let wasmBase = null;
      for (let m = 0; m < WASM_MIRRORS.length; m++) {
        const base = WASM_MIRRORS[m] || "https://cdn.jsdelivr.net/npm/@huggingface/transformers@" + ((mod.env && mod.env.version) || "3.0.0") + "/dist/";
        try {
          const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 15000);
          try { const r = await fetch(base + "ort-wasm-simd-threaded.jsep.wasm", { headers: { Range: "bytes=0-0" }, signal: ctl.signal }); d.probe = (d.probe || "") + (m ? " " : "") + (WASM_MIRRORS[m] ? "mirror" : "default") + "=" + r.status; if (r.ok || r.status === 206) { wasmBase = WASM_MIRRORS[m]; d.wasmHost = new URL(base).host; break; } } finally { clearTimeout(tm); }
        } catch (e) { d.probe = (d.probe || "") + (m ? " " : "") + (WASM_MIRRORS[m] ? "mirror" : "default") + "=" + String(e && e.name || "err"); }
      }
      const progress = (p) => { lastAct = Date.now(); try { if (p && p.status === "progress" && typeof p.loaded === "number" && p.file) { fileBytes[p.file] = p.loaded; d.bytes = Object.values(fileBytes).reduce((a, b) => a + b, 0); } } catch (e) {} progress0(p); };
      let fileBytes = {};
      // iPhone/iPad: у WebContent мало памяти — сначала лёгкая модель (tiny), потом остальные
      const ios = typeof navigator !== "undefined" && (/iP(hone|ad|od)/.test(navigator.userAgent || "") || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
      const PLAN = ios ? LOAD_PLAN.slice().sort((a, b) => (a.model === FALLBACK_MODEL ? 0 : 1) - (b.model === FALLBACK_MODEL ? 0 : 1)) : LOAD_PLAN;
      for (let i = 0; i < PLAN.length; i++) {
        const plan = PLAN[i];
        const at = { model: plan.model, dtype: plan.dtype, mirror: plan.mirror, stage: "env" };
        d.attempts.push(at); d.stage = "env"; fileBytes = {}; d.http = [];
        try {
          const env = mod.env; env.allowLocalModels = false; env.useBrowserCache = !!plan.cache;
          // Safari без cross-origin isolation не даёт SharedArrayBuffer: onnxruntime должен работать в один поток без прокси-воркера
          try { const w = env.backends.onnx.wasm; w.numThreads = 1; w.proxy = false; if (wasmBase) w.wasmPaths = wasmBase; } catch (e) {}
          at.stage = d.stage = "model"; lastAct = Date.now();
          let timer;
          const stall = new Promise((_, rej) => { timer = setInterval(() => { if (Date.now() - lastAct > STALL_MS) { clearInterval(timer); rej(new Error("timeout: stall " + STALL_MS / 1000 + "s")); } }, 3000); });
          let asr;
          try { asr = await Promise.race([mod.pipeline("automatic-speech-recognition", plan.model, { progress_callback: progress, dtype: plan.dtype, device: "wasm" }), stall]); } finally { clearInterval(timer); }
          notify(100);
          engine = async (audio, o) => { const out = await asr(audio, Object.assign({ chunk_length_s: 30, return_timestamps: false }, o || {})); return String((out && out.text) || "").trim(); };
          engine.modelName = plan.model;
          at.ok = true; d.stage = "ready"; d.ok = true; return engine;
        } catch (e) {
          lastErr = e; const msg = String(e && e.message || e);
          const codes = (msg.match(/\b(?:status|code)\D{0,3}(\d{3})\b|\((\d{3})\)|\b([45]\d\d)\b/g) || []).map((x) => +x.replace(/\D/g, "")).filter((n) => n >= 400 && n < 600);
          if (codes.length) d.http = codes;
          at.error = { name: String(e && e.name || "Error"), msg: cleanMsg(msg) };
          try { etherLog("warn", "[localai] попытка загрузки " + (i + 1) + " (" + plan.model + ", этап " + at.stage + ") не удалась:", at.error.name, at.error.msg); } catch (x) {}
        }
      }
      const last = d.attempts[d.attempts.length - 1] || {};
      d.error = last.error || { name: "Error", msg: "?" }; d.stage = last.stage || d.stage; d.hint = hintFor(d.stage, d.error.name, d.error.msg, d.http);
      throw tagged(lastErr, d);
    })();
    try { return await loading; } finally { loading = null; }
  }
  function tagged(e, d) { const err = e instanceof Error ? e : new Error(String(e)); try { err.localAiDiag = d; } catch (x) {} return err; }
  function getDiag() { return diag; }
  // Звук → моно 16 кГц Float32 (вход Whisper)
  async function decodeToMono16k(blob) {
    const AC = window.AudioContext || window.webkitAudioContext, OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!AC || !OAC) throw new Error("no-webaudio");
    const buf = await blob.arrayBuffer();
    const ctx = new AC(); let audio;
    try { audio = await ctx.decodeAudioData(buf.slice(0)); } finally { try { ctx.close(); } catch (e) {} }
    if (audio.duration > MAX_AUDIO_SEC) throw new Error("too-long");
    const off = new OAC(1, Math.max(1, Math.ceil(audio.duration * 16000)), 16000);
    const src = off.createBufferSource(); src.buffer = audio; src.connect(off.destination); src.start();
    return (await off.startRendering()).getChannelData(0);
  }
  function languageOption() {
    let mode = "ui"; try { mode = localStorage.getItem("ether.localAiLang") || "ui"; } catch (e) {}
    if (mode !== "ui") return {};
    const code = (document.documentElement.getAttribute("lang") || "en").slice(0, 2);
    return LANG_NAMES[code] ? { language: LANG_NAMES[code], task: "transcribe" } : {};
  }
  // Whisper на коротких и тихих записях любит «зацикливаться» («8,8,8,8…»). Защита в три слоя:
  // 1) тишину не распознаём; 2) ограничиваем длину ответа по длительности звука и запрещаем повторы n-грамм;
  // 3) схлопываем оставшиеся повторы в тексте.
  function rms(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / Math.max(1, a.length)); }
  function cleanTranscript(text) {
    let toks = String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    // слитные «8,8,8,8» делим по запятым/точкам, чтобы увидеть повтор
    toks = toks.flatMap((t) => (/^(?:[^\s,.;]{1,6}[,.;]){3,}/.test(t) ? t.split(/(?<=[,.;])/) : [t]));
    for (let n = 1; n <= 4; n++) {
      for (let i = 0; i + n * 3 <= toks.length; i++) {
        let reps = 1;
        while (i + (reps + 1) * n <= toks.length && toks.slice(i, i + n).join("|").replace(/[,.;]/g, "") === toks.slice(i + reps * n, i + (reps + 1) * n).join("|").replace(/[,.;]/g, "")) reps++;
        if (reps >= 3) { toks.splice(i + n, (reps - 1) * n); toks[i + n - 1] += "…"; }
      }
    }
    return toks.join(" ").replace(/…+/g, "…").replace(/([,.;])…/g, "…").trim();
  }
  async function transcribeBlob(blob) {
    const run = await loadEngine();
    const audio = await decodeToMono16k(blob);
    if (rms(audio) < 0.003) return "";
    // Громкость не нормализуем: лог-мел признаки Whisper и так не зависят от уровня сигнала
    const sec = audio.length / 16000;
    // кириллица режется на много коротких токенов — прежний лимит (6 ток/с) обрезал русские записи на полуслове
    const lang = languageOption();
    const tokens = Math.max(48, Math.min(440, Math.ceil(sec * 14) + 30));
    // Несколько попыток от «строгих» настроек к самым простым: если модель при ограничениях вернула пустоту,
    // повторяем с настройками библиотеки по умолчанию (иначе пользователь видит «ничего не распознано»).
    const attempts = [
      Object.assign({ max_new_tokens: tokens, no_repeat_ngram_size: 4 }, lang),
      Object.assign({}, lang),
      {},
    ];
    for (let i = 0; i < attempts.length; i++) {
      let text = "";
      try { text = cleanTranscript(await run(audio, attempts[i])); } catch (e) { try { etherLog("warn", "[localai] попытка " + (i + 1) + " упала:", String(e && e.message || e)); } catch (x) {} if (i === attempts.length - 1) throw e; }
      try { etherLog("info", "[localai] попытка " + (i + 1) + ", модель " + (run.modelName || "?") + ", " + sec.toFixed(1) + " с, символов: " + text.length); } catch (x) {}
      if (text) return text;
    }
    return "";
  }

  // ---- Краткое содержание: частотная выжимка (extractive) ----
  const STOP = new Set("и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между the a an and or but of to in on at for with is are was were be been it this that these those i you he she we they my your his her our their not no as by from so if then than".split(/\s+/));
  function sentences(text) { return String(text || "").replace(/\s+/g, " ").match(/[^.!?…]+[.!?…]*/g) || []; }
  function summarize(text, maxSentences) {
    const n = maxSentences || 3;
    const sents = sentences(text).map((s) => s.trim()).filter((s) => s.length > 2);
    if (sents.length <= n) return sents.join(" ");
    const freq = new Map();
    const words = (s) => s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];
    for (const s of sents) for (const w of words(s)) if (!STOP.has(w)) freq.set(w, (freq.get(w) || 0) + 1);
    const scored = sents.map((s, i) => {
      const ws = words(s).filter((w) => !STOP.has(w));
      const score = ws.length ? ws.reduce((a, w) => a + (freq.get(w) || 0), 0) / Math.sqrt(ws.length) : 0;
      return { s, i, score: score * (i === 0 ? 1.15 : 1) };
    });
    return scored.sort((a, b) => b.score - a.score).slice(0, n).sort((a, b) => a.i - b.i).map((x) => x.s).join(" ");
  }

  // ---- Сводка чата: детерминированная выжимка за период (без нейросети, без сети) ----
  const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"']{3,200}/gi;
  function chatDigest(c, opts) {
    opts = opts || {};
    const now = opts.now || Date.now(), since = opts.since || 0;
    const all = (c && Array.isArray(c.messages) ? c.messages : []).filter((m) => m && !m.deleted && m.from !== "system" && Number(m.ts) >= since && Number(m.ts) <= now + 60000);
    const nameOf = (m) => m.from === "me" ? (opts.meName || "me") : String(m.fromName || (c && c.name) || opts.someone || "?").slice(0, 40);
    const authorKey = (m) => m.from === "me" ? "me" : (m.fromId || "them");
    const people = new Map();
    const files = { image: 0, video: 0, audio: 0, file: 0 };
    const links = [], polls = [], notes = [], textParts = [], questions = [];
    const wordFreq = new Map();
    let texts = 0;
    all.forEach((m, idx) => {
      const k = authorKey(m); const p = people.get(k) || { name: nameOf(m), n: 0 }; p.n++; people.set(k, p);
      if (m.file) { const kind = files[m.file.kind] !== undefined ? m.file.kind : "file"; files[kind]++; }
      if (m.poll && typeof m.poll.q === "string") polls.push(String(m.poll.q).slice(0, 120));
      if (m.note && typeof m.note.title === "string") notes.push(String(m.note.title).slice(0, 60));
      const t = typeof m.text === "string" ? m.text.trim() : "";
      if (!t) return;
      texts++;
      const found = t.match(URL_IN_TEXT); if (found) for (const u of found) if (links.length < 50 && !links.includes(u)) links.push(u);
      textParts.push(/[.!?…]$/.test(t) ? t : t + ".");
      for (const w of t.toLowerCase().replace(URL_IN_TEXT, " ").match(/[\p{L}][\p{L}\p{N}-]{3,}/gu) || []) if (!STOP.has(w)) wordFreq.set(w, (wordFreq.get(w) || 0) + 1);
      if (/\?\s*$/.test(t) && t.length > 3) {
        const answered = all.slice(idx + 1).some((x) => authorKey(x) !== k || (x.replyTo && (x.replyTo.id || x.replyTo.msgId) === m.id));
        if (!answered) questions.push({ who: nameOf(m), text: t.slice(0, 160), ts: m.ts });
      }
    });
    const topics = Array.from(wordFreq).filter((e) => e[1] >= 2).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 6).map((e) => e[0]);
    // Открытые задачи досок: карточки не в последней колонке (последняя колонка считается «готово»)
    const tasks = [];
    for (const m of (c && Array.isArray(c.messages) ? c.messages : [])) {
      const b = m && !m.deleted && m.board; if (!b || !Array.isArray(b.cols) || !b.cols.length || !Array.isArray(b.cards)) continue;
      const doneCol = b.cols[b.cols.length - 1].id;
      for (const card of b.cards) if (card && card.col !== doneCol && tasks.length < 30) tasks.push({ board: String(b.title || "").slice(0, 60), text: String(card.t || "").slice(0, 120) });
    }
    const joined = textParts.join(" ").slice(-20000);
    const key = texts >= 4 ? summarize(joined, 3) : "";
    return {
      count: all.length, texts,
      people: Array.from(people.values()).sort((a, b) => b.n - a.n).slice(0, 8),
      topics, key, questions: questions.slice(-5), links: links.slice(0, 8), files, polls: polls.slice(0, 5), notes: notes.slice(0, 5), tasks: tasks.slice(0, 10),
    };
  }
  return { TF_SHA384, chatDigest, makeProgress, cleanTranscript, rms, setEngine, isReady, loadEngine, decodeToMono16k, transcribeBlob, summarize, sentences, onProgress: (fn) => { progressListeners.add(fn); return () => progressListeners.delete(fn); }, MODEL, TF_URL, getDiag, envInfo, hintFor, LOAD_PLAN, importLib };
})();

// ---- Интеграция с чатом ----
function localAiEnabled() { try { return localStorage.getItem("ether.localAi") === "1"; } catch (e) { return false; } }
async function transcribeVoiceMessage(contactId, msgId) {
  const c = state.contacts.get(contactId), m = c && c.messages.find((x) => x.id === msgId);
  if (!m || !m.file || m.file.kind !== "audio") return;
  if (m.file.transcript) { toggleTranscript(msgId); return; }
  if (!localAiEnabled()) {
    if (!(await confirmSheet(T("ai.consent")))) return;
    try { localStorage.setItem("ether.localAi", "1"); } catch (e) {}
    const sw = document.getElementById("settings-local-ai"); if (sw) sw.checked = true;
  }
  const box = () => Array.from(document.querySelectorAll(".voice-bubble[data-file-id]")).find((b) => b.getAttribute("data-file-id") === msgId);
  const setStatus = (txt) => { const b = box(); if (!b) return; let t = b.querySelector(".voice-transcript"); if (!t) { t = document.createElement("div"); t.className = "voice-transcript"; b.appendChild(t); } t.textContent = txt; t.classList.add("is-status"); };
  const off = LocalAI.onProgress((p) => setStatus(T("ai.loading", { n: Math.round(p) })));
  try {
    const blob = await IDB.get("file:" + msgId);
    if (!blob) { toast(T("chat.file.unavailable")); return; }
    setStatus(LocalAI.isReady() ? T("ai.working") : T("ai.loading", { n: 0 }));
    const text = await LocalAI.transcribeBlob(blob);
    if (!text) { // пустой результат не сохраняем: иначе заглушка блокирует повторную попытку
      const b0 = box(); const t0 = b0 && b0.querySelector(".voice-transcript"); if (t0) t0.remove();
      toast(T("ai.nothing")); return;
    }
    m.file.transcript = text; m.rv = (m.rv || 0) + 1; // rv входит в «подпись» ленты — без него чат не перерисуется
    persistContacts();
    if (state.chatId === contactId) renderChatThread();
  } catch (e) {
    const b = box(); const t = b && b.querySelector(".voice-transcript"); if (t) t.remove();
    toast(T(e && e.message === "too-long" ? "ai.tooLong" : "ai.failed"));
    try { etherLog("warn", "[localai]", String(e && e.message || e)); } catch (x) {}
  } finally { off(); }
}
function toggleTranscript(msgId) {
  const b = Array.from(document.querySelectorAll(".voice-bubble[data-file-id]")).find((x) => x.getAttribute("data-file-id") === msgId);
  const t = b && b.querySelector(".voice-transcript"); if (t) t.classList.toggle("hidden");
}
// Лист «Краткое содержание» для длинного сообщения или расшифровки
function openSummarySheet(text) {
  const sheet = document.getElementById("ai-sheet"); if (!sheet) return;
  const out = LocalAI.summarize(text, 3);
  document.getElementById("ai-sheet-text").textContent = out || T("ai.nothing");
  sheet.classList.remove("hidden");
}
function messageSummarySource(m) { return (m.file && m.file.transcript) || m.text || ""; }

// ---- Сводка чата: шторка с выбором периода ----
function summarySince(period, now) {
  now = now || Date.now();
  if (period === "today") { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); }
  if (period === "week") return now - 7 * 864e5;
  return 0;
}
function chatSummaryHtml(c, period) {
  const d = LocalAI.chatDigest(c, { since: summarySince(period), meName: T("chat.poll.you"), someone: T("sys.someone") });
  const e = escapeHtml;
  if (!d.count) return `<p class="summary-empty">${e(T("summary.empty"))}</p>`;
  const sec = (title, inner) => `<section class="summary-sec"><h4>${e(title)}</h4>${inner}</section>`;
  const list = (items) => `<ul class="summary-list">${items.map((x) => `<li>${x}</li>`).join("")}</ul>`;
  let h = `<p class="summary-count">${e(T("summary.messages", { n: d.count }))}</p>`;
  if (d.people.length) h += sec(T("summary.people"), list(d.people.map((p) => e(T("summary.person", { name: p.name, n: p.n })))));
  if (d.topics.length) h += sec(T("summary.topics"), `<div class="summary-chips">${d.topics.map((w) => `<span class="summary-chip">${e(w)}</span>`).join("")}</div>`);
  if (d.key) h += sec(T("summary.key"), `<p class="summary-key">${e(d.key)}</p>`);
  if (d.questions.length) h += sec(T("summary.questions"), list(d.questions.map((q) => `<b>${e(q.who)}:</b> ${e(q.text)}`)));
  if (d.tasks.length) h += sec(T("summary.tasks"), list(d.tasks.map((x) => `${e(x.text)} <span class="muted">· ${e(x.board)}</span>`)));
  if (d.polls.length) h += sec(T("summary.polls"), list(d.polls.map(e)));
  if (d.notes.length) h += sec(T("summary.notes"), list(d.notes.map(e)));
  if (d.links.length) h += sec(T("summary.links"), list(d.links.map((u) => `<span class="summary-url">${e(u)}</span>`)));
  const fl = ["image", "video", "audio", "file"].filter((k) => d.files[k] > 0).map((k) => e(T("summary.files." + k, { n: d.files[k] })));
  if (fl.length) h += sec(T("summary.files"), list(fl));
  return h;
}
function renderChatSummary() {
  const sheet = document.getElementById("summary-sheet"), body = document.getElementById("summary-body"); if (!sheet || !body) return;
  const c = state.contacts.get(sheet.dataset.cid); if (!c) { sheet.classList.add("hidden"); return; }
  const period = sheet.dataset.period || "week";
  sheet.querySelectorAll(".summary-period").forEach((b) => { const on = b.dataset.period === period; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on ? "true" : "false"); });
  body.innerHTML = chatSummaryHtml(c, period);
}
function openChatSummary(contactId) {
  const sheet = document.getElementById("summary-sheet"); if (!sheet || !state.contacts.get(contactId)) return;
  sheet.dataset.cid = contactId; sheet.dataset.period = "week";
  renderChatSummary(); sheet.classList.remove("hidden");
  setTimeout(() => { try { const b = sheet.querySelector(".summary-period.on"); if (b) b.focus(); } catch (e) {} }, 40);
}
function wireChatSummary() {
  const sheet = document.getElementById("summary-sheet"); if (!sheet) return;
  sheet.querySelectorAll(".summary-period").forEach((b) => b.addEventListener("click", () => { sheet.dataset.period = b.dataset.period; renderChatSummary(); }));
  const cp = document.getElementById("summary-copy"); if (cp) cp.addEventListener("click", () => { try { const b = document.getElementById("summary-body"); copyText(b.innerText || b.textContent, T("toast.msgCopied")); } catch (e) {} });
  for (const id of ["chat-summary-btn", "contact-summary-btn"]) {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener("click", () => { try { collapseComposerPlus(); } catch (e) {} const cid = state.chatId || state.contactCardId; if (cid) openChatSummary(cid); });
  }
}
function wireLocalAi() {
  try { wireChatSummary(); } catch (e) {}
  const sw = document.getElementById("settings-local-ai");
  if (sw) { sw.checked = localAiEnabled(); sw.addEventListener("change", () => { try { localStorage.setItem("ether.localAi", sw.checked ? "1" : "0"); } catch (e) {} }); }
  const sel = document.getElementById("settings-local-ai-lang");
  if (sel) { try { sel.value = localStorage.getItem("ether.localAiLang") || "ui"; } catch (e) {} sel.addEventListener("change", () => { try { localStorage.setItem("ether.localAiLang", sel.value); } catch (e) {} }); }
  const del = document.getElementById("settings-local-ai-delete");
  if (del) del.addEventListener("click", async () => {
    try { const keys = (await caches.keys()).filter((k) => /transformers/i.test(k)); await Promise.all(keys.map((k) => caches.delete(k))); toast(T("ai.deleted")); } catch (e) { toast(T("ai.failed")); }
  });
  const copy = document.getElementById("ai-sheet-copy");
  if (copy) copy.addEventListener("click", () => { try { copyText(document.getElementById("ai-sheet-text").textContent, T("toast.msgCopied")); } catch (e) {} });
}
