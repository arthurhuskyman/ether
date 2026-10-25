// Локальный полнотекстовый поиск по сообщениям всех чатов. Индекс — только в памяти (инвертированный: токен -> документы), НИКОГДА не сохраняется:
// при запуске строится заново из уже расшифрованного кэша чатов, порциями с отдачей управления циклу событий. Тексты не копируются: документ хранит
// ссылку на объект сообщения и номера токенов (для фраз). Токенизация: Unicode-слова, регистр и диакритика не важны (ё=е, й=и, é=e), арабская
// нормализация (огласовки, татвил, варианты алефа, ى/ي, ة/ه, арабо-индийские цифры) — безопасна для RTL: подсветка считается по смещениям в исходной строке.
// Запрос: слова (по умолчанию префиксные, все должны встретиться), "фраза в кавычках" (точные подряд идущие слова), операторы
// in:<чат> from:<отправитель> type:media|links|files|voice after:ГГГГ-ММ-ДД before:ГГГГ-ММ-ДД. Ранжирование: idf слов, точное слово > префикс, фраза, свежесть.
const MsgSearch = (() => {
  const T_MEDIA = 1, T_LINK = 2, T_FILE = 4, T_VOICE = 8;
  const TYPE_BITS = { media: T_MEDIA, links: T_LINK, link: T_LINK, files: T_FILE, file: T_FILE, voice: T_VOICE, audio: T_VOICE };
  const MARKS = /[̀-֑ͯ-ׇً-ٰٟـۖ-ۭ]/g;
  const WORD = /[\p{L}\p{N}\p{M}]+/gu;
  const FOLD = { "ł": "l", "ø": "o", "đ": "d", "ı": "i", "æ": "ae", "œ": "oe", "ß": "ss", "ð": "d", "þ": "th" };
  const AR = { "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ى": "ي", "ة": "ه", "ؤ": "و", "ئ": "ي", "ک": "ك", "ی": "ي" };
  function norm(s) {
    s = String(s == null ? "" : s).toLowerCase().normalize("NFKD").replace(MARKS, "");
    return s.replace(/[łøđıæœßðþکیأإآٱىةؤئ]/g, (c) => FOLD[c] || AR[c] || c).replace(/[٠-٩۰-۹]/g, (c) => String(c.charCodeAt(0) - (c.charCodeAt(0) >= 0x06f0 ? 0x06f0 : 0x0660)));
  }
  // [{raw, n, start, end}]
  function scan(text) {
    const out = []; WORD.lastIndex = 0; let m;
    const s = String(text == null ? "" : text);
    while ((m = WORD.exec(s))) { const n = norm(m[0]); if (n) out.push({ n, start: m.index, end: m.index + m[0].length }); }
    return out;
  }
  const tokens = (text) => scan(text).map((t) => t.n);
  const URL_RE = /\b(?:https?:\/\/|www\.)\S+/i;

  function textOf(m) {
    if (!m) return "";
    let t = typeof m.text === "string" ? m.text : "";
    if (m.file) { if (m.file.caption) t += (t ? " " : "") + m.file.caption; if (m.file.name) t += (t ? " " : "") + m.file.name; }
    if (m.poll && m.poll.question) t += (t ? " " : "") + m.poll.question;
    if (m.note && m.note.title) t += (t ? " " : "") + m.note.title;
    if (m.contactCard && m.contactCard.name) t += (t ? " " : "") + m.contactCard.name;
    return t;
  }
  function typeOf(m) {
    let b = 0; const f = m.file;
    if (f) { if (f.kind === "image" || f.kind === "video") b |= T_MEDIA; else if (f.kind === "audio") b |= T_VOICE; else b |= T_FILE; }
    if (m.sticker) b |= T_MEDIA;
    if (URL_RE.test(typeof m.text === "string" ? m.text : "")) b |= T_LINK;
    return b;
  }

  function parseDate(s, endOfDay) {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s); if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3], endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
    return isNaN(d.getTime()) ? null : d.getTime();
  }
  // -> { terms: [norm], phrases: [[norm...]], filters: { in, from, type, after, before } }
  function parseQuery(q) {
    const res = { terms: [], phrases: [], filters: {} };
    let rest = String(q || "");
    rest = rest.replace(/(?:^|\s)(in|from|type|after|before):("([^"]*)"|\S+)/gi, (_, k, v, qv) => {
      k = k.toLowerCase(); v = (qv != null ? qv : v).trim();
      if (k === "type") { const b = TYPE_BITS[v.toLowerCase()]; if (b) res.filters.type = b; }
      else if (k === "after") { const d = parseDate(v, false); if (d != null) res.filters.after = d; }
      else if (k === "before") { const d = parseDate(v, true); if (d != null) res.filters.before = d; }
      else if (v) res.filters[k] = norm(v);
      return " ";
    });
    rest = rest.replace(/["«“]([^"»”]+)["»”]/g, (_, p) => { const t = tokens(p); if (t.length > 1) res.phrases.push(t); else if (t.length === 1) res.terms.push({ t: t[0], exact: true }); return " "; });
    for (const t of tokens(rest)) res.terms.push({ t, exact: false });
    return res;
  }

  function create() {
    let docs = [];            // { chat, msg, ts, from, flags, toks:Int32Array, dead }
    const postings = new Map(); // token -> number[] (doc ids, по возрастанию)
    const vocab = new Map();    // token -> id
    let sorted = null;
    const chatIds = new Map(), chatNames = new Map(); // chat id -> doc count / norm(name)
    let gen = 0;

    function addDoc(chat, msg) {
      if (!msg || msg.from === "system" || msg.deleted) return -1;
      const text = textOf(msg);
      const tk = tokens(text);
      if (!tk.length) return -1;
      const id = docs.length, ids = new Int32Array(tk.length), seen = new Set();
      for (let i = 0; i < tk.length; i++) {
        let vid = vocab.get(tk[i]); if (vid === undefined) { vid = vocab.size; vocab.set(tk[i], vid); }
        ids[i] = vid;
        if (!seen.has(tk[i])) { seen.add(tk[i]); let p = postings.get(tk[i]); if (!p) { p = []; postings.set(tk[i], p); sorted = null; } p.push(id); }
      }
      docs.push({ chat, msg, ts: Number(msg.ts) || 0, from: msg.from === "me" ? "\u0001me" : norm(msg.fromName || ""), flags: typeOf(msg), toks: ids, dead: false });
      chatIds.set(chat, (chatIds.get(chat) || 0) + 1);
      return id;
    }
    function removeMessage(chat, msgId) {
      let n = 0;
      for (const d of docs) if (!d.dead && d.chat === chat && d.msg.id === msgId) { d.dead = true; n++; chatIds.set(chat, (chatIds.get(chat) || 1) - 1); }
      return n;
    }
    function updateMessage(chat, msg) { removeMessage(chat, msg.id); return addDoc(chat, msg) >= 0; }
    function removeChat(chat) { for (const d of docs) if (!d.dead && d.chat === chat) d.dead = true; chatIds.delete(chat); chatNames.delete(chat); }
    function clear() { docs = []; postings.clear(); vocab.clear(); chatIds.clear(); chatNames.clear(); sorted = null; gen++; }
    function setChatName(chat, name) { chatNames.set(chat, norm(name || "")); }

    // Инкрементальная сборка из чатов [{id, name, messages}]: порции по sliceMs, между ними отдаём управление (setTimeout 0).
    function build(chats, opts) {
      opts = opts || {};
      const slice = opts.sliceMs || 8, my = ++gen;
      const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
      const yieldFn = opts.yieldFn || (() => new Promise((r) => setTimeout(r, 0)));
      return (async () => {
        let t0 = now(), n = 0;
        for (const c of chats) {
          if (my !== gen) return n;
          setChatName(c.id, c.name);
          const ms = c.messages || [];
          for (let i = 0; i < ms.length; i++) {
            if (addDoc(c.id, ms[i]) >= 0) n++;
            if ((i & 63) === 63 && now() - t0 > slice) { if (opts.onProgress) opts.onProgress(n); await yieldFn(); if (my !== gen) return n; t0 = now(); }
          }
        }
        if (opts.onProgress) opts.onProgress(n);
        return n;
      })();
    }

    function sortedTokens() { return sorted || (sorted = Array.from(postings.keys()).sort()); }
    function expand(term) { // токены с данным префиксом (бинарный поиск по отсортированному списку)
      const arr = sortedTokens(); let lo = 0, hi = arr.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < term) lo = mid + 1; else hi = mid; }
      const out = []; for (let i = lo; i < arr.length && arr[i].startsWith(term) && out.length < 300; i++) out.push(arr[i]);
      return out;
    }

    // opts: { limit, chats: Set|array of ids (ограничение), sender: norm-строка, type, after, before, chatFilterName }
    function search(query, opts) {
      opts = opts || {};
      const q = typeof query === "string" ? parseQuery(query) : query;
      const F = Object.assign({}, q.filters, opts);
      const limit = opts.limit || 50, N = docs.length;
      let chatSet = null;
      if (F.chats) chatSet = new Set(F.chats);
      if (F.in) { // оператор in: — по названию чата
        const ids = new Set(); for (const [id, nm] of chatNames) if (nm.includes(F.in)) ids.add(id);
        chatSet = chatSet ? new Set(Array.from(ids).filter((x) => chatSet.has(x))) : ids;
      }
      const pass = (d) => !d.dead && (!chatSet || chatSet.has(d.chat)) && (!F.type || (d.flags & F.type)) && (F.after == null || d.ts >= F.after) && (F.before == null || d.ts <= F.before) &&
        (!F.from || (F.from === "me" ? d.from === "\u0001me" : d.from.includes(F.from)));
      const hasText = q.terms.length || q.phrases.length;
      const out = [];
      if (!hasText) { // только фильтры: самые свежие подходящие
        for (let i = N - 1; i >= 0 && out.length < limit * 4; i--) if (pass(docs[i])) out.push({ i, score: 0 });
      } else {
        // кандидаты: пересечение документов по каждому слову (префикс) и каждому слову фразы (точно)
        const groups = [];
        for (const t of q.terms) {
          const toks = t.exact ? (postings.has(t.t) ? [t.t] : []) : expand(t.t);
          groups.push({ t, toks });
        }
        for (const ph of q.phrases) for (const w of ph) groups.push({ t: { t: w, exact: true }, toks: postings.has(w) ? [w] : [] });
        if (groups.some((g) => !g.toks.length)) return [];
        const cnt = new Uint16Array(N), sc = new Float32Array(N), best = new Float32Array(N);
        for (const g of groups) {
          best.fill(0);
          for (const tk of g.toks) {
            const p = postings.get(tk), v = (tk === g.t.t ? 1 : 0.5) + 0.3 * Math.log(1 + N / (p.length + 1));
            for (let k = 0; k < p.length; k++) { const d = p[k]; if (v > best[d]) best[d] = v; }
          }
          for (let d = 0; d < N; d++) if (best[d] > 0) { cnt[d]++; sc[d] += best[d]; }
        }
        const need = groups.length;
        for (let i = 0; i < N; i++) if (cnt[i] === need && pass(docs[i])) out.push({ i, score: sc[i] });
        // фразы: проверяем подряд идущие токены
        if (q.phrases.length) {
          const pids = q.phrases.map((ph) => ph.map((w) => vocab.get(w)));
          for (let k = out.length - 1; k >= 0; k--) {
            const tk = docs[out[k].i].toks; let ok = true;
            for (const ids of pids) { if (!hasSeq(tk, ids)) { ok = false; break; } }
            if (!ok) out.splice(k, 1); else out[k].score += 2 * q.phrases.length;
          }
        }
      }
      const maxTs = N ? docs[N - 1].ts || 1 : 1;
      for (const r of out) { const d = docs[r.i]; r.score += hasText ? 0.15 * (d.ts / (maxTs || 1)) : 0; }
      out.sort((a, b) => b.score - a.score || docs[b.i].ts - docs[a.i].ts);
      const hl = highlighter(q);
      return out.slice(0, limit).map((r) => { const d = docs[r.i]; return { chat: d.chat, id: d.msg.id, ts: d.ts, mine: d.from === "\u0001me", sender: d.msg.fromName || "", type: d.flags, score: r.score, snippet: hl(textOf(d.msg)) }; });
    }
    function hasSeq(tk, ids) { outer: for (let i = 0; i + ids.length <= tk.length; i++) { for (let j = 0; j < ids.length; j++) if (tk[i + j] !== ids[j]) continue outer; return true; } return false; }

    // Сниппет с подсветкой: [{t, hit}] (без HTML — вызывающий экранирует; смещения из исходной строки, поэтому RTL не ломается)
    function highlighter(q) {
      const prefixes = q.terms.filter((t) => !t.exact).map((t) => t.t), exacts = new Set(q.terms.filter((t) => t.exact).map((t) => t.t));
      for (const ph of q.phrases) for (const w of ph) exacts.add(w);
      return (text, radius) => {
        radius = radius || 48;
        const sc = scan(text), hits = sc.filter((t) => exacts.has(t.n) || prefixes.some((p) => t.n.startsWith(p)));
        if (!hits.length) return [{ t: String(text).slice(0, radius * 2) + (String(text).length > radius * 2 ? "…" : ""), hit: false }];
        let a = Math.max(0, hits[0].start - radius), b = Math.min(text.length, hits[0].end + radius * 1.5);
        if (a > 0) { const sp = text.indexOf(" ", a); if (sp >= 0 && sp < hits[0].start) a = sp + 1; }
        const segs = []; let pos = a;
        if (a > 0) segs.push({ t: "…", hit: false });
        for (const h of hits) {
          if (h.end <= a || h.start >= b) continue;
          if (h.start > pos) segs.push({ t: text.slice(pos, h.start), hit: false });
          segs.push({ t: text.slice(Math.max(h.start, pos), h.end), hit: true }); pos = h.end;
        }
        if (pos < b) segs.push({ t: text.slice(pos, b), hit: false });
        if (b < text.length) segs.push({ t: "…", hit: false });
        return segs;
      };
    }
    return { addMessage: (chat, msg) => addDoc(chat, msg) >= 0, removeMessage, updateMessage, removeChat, clear, setChatName, build, search, highlighter, size: () => docs.filter((d) => !d.dead).length, docCount: () => docs.length, vocabSize: () => vocab.size };
  }
  return { create, norm, tokens, scan, parseQuery, textOf, typeOf, T_MEDIA, T_LINK, T_FILE, T_VOICE };
})();
if (typeof module !== "undefined") module.exports = MsgSearch;
