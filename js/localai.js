// =====================================================================
// Локальный ИИ: распознавание голосовых (Whisper-tiny в WebAssembly, transformers.js) и краткое содержание.
// Звук никуда не отправляется — модель выполняется на устройстве. Единственное обращение в сеть — разовая загрузка библиотеки
// (cdn.jsdelivr.net) и модели (huggingface.co, ≈40 МБ); поэтому функция включается только после явного согласия,
// а при загрузке эти серверы видят IP-адрес. Модель кэшируется браузером; удалить её можно в настройках.
// «Краткое содержание» — выжимка ключевых предложений без нейросети (работает сразу и без загрузок).
// Загружается после app.js; использует его глобалы (state, Store, IDB, T, toast, confirmSheet, persistContacts…).
// =====================================================================
const LocalAI = (() => {
  const TF_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.0/dist/transformers.min.js";
  const MODEL = "Xenova/whisper-tiny";
  const MAX_AUDIO_SEC = 300;
  const LANG_NAMES = { ru: "russian", en: "english", de: "german", fr: "french", es: "spanish", it: "italian", pt: "portuguese", uk: "ukrainian", pl: "polish", tr: "turkish", ar: "arabic", zh: "chinese", ja: "japanese", ko: "korean", hi: "hindi", nl: "dutch", cs: "czech", sv: "swedish", he: "hebrew", fa: "persian" };
  let engine = null, loading = null;
  const progressListeners = new Set();
  const notify = (p) => progressListeners.forEach((fn) => { try { fn(p); } catch (e) {} });

  // Подмена движка (тесты и возможные другие реализации): async (Float32Array, { language }) => string
  function setEngine(fn) { engine = fn; }
  function isReady() { return !!engine; }
  async function loadEngine() {
    if (engine) return engine;
    if (loading) return loading;
    loading = (async () => {
      const mod = await import(TF_URL);
      mod.env.allowLocalModels = false;
      const asr = await mod.pipeline("automatic-speech-recognition", MODEL, {
        progress_callback: (p) => { if (p && typeof p.progress === "number") notify(Math.max(0, Math.min(100, p.progress))); },
      });
      engine = async (audio, o) => { const out = await asr(audio, Object.assign({ chunk_length_s: 30, return_timestamps: false }, o || {})); return String((out && out.text) || "").trim(); };
      return engine;
    })();
    try { return await loading; } finally { loading = null; }
  }
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
  // Whisper-tiny на коротких и тихих записях любит «зацикливаться» («8,8,8,8…»). Защита в три слоя:
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
    const sec = audio.length / 16000;
    const opts = Object.assign({ max_new_tokens: Math.max(24, Math.min(220, Math.ceil(sec * 6) + 20)), no_repeat_ngram_size: 3, repetition_penalty: 1.2 }, languageOption());
    return cleanTranscript(await run(audio, opts));
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
  return { cleanTranscript, rms, setEngine, isReady, loadEngine, decodeToMono16k, transcribeBlob, summarize, sentences, onProgress: (fn) => { progressListeners.add(fn); return () => progressListeners.delete(fn); }, MODEL, TF_URL };
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
    m.file.transcript = text || T("ai.nothing"); m.rv = (m.rv || 0) + 1; // rv входит в «подпись» ленты — без него чат не перерисуется
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
function wireLocalAi() {
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
