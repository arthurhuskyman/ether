// Опросы и доски (канбан) в чате: чистая логика без DOM — очистка чужих данных, подсчёт голосов, применение операций.
// Состояние живёт в самом сообщении: m.poll + m.pollVotes, m.board. Операции идемпотентны и сходятся при доставке не по порядку:
// голос заменяет прежний голос того же человека; карточки доски меняются «последняя запись побеждает» по времени операции,
// удалённая карточка запоминается (надгробие), чтобы запоздавшее «добавить/переместить» её не воскресило.
(function (root) {
  "use strict";
  const LIM = { q: 200, opts: 6, opt: 80, title: 60, cols: 5, col: 24, cards: 100, card: 120, dead: 200 };
  const str = (s, n) => (typeof s === "string" ? s.replace(/[\u0000-\u0008\u000b-\u001f]/g, "").trim().slice(0, n) : "");
  const idOk = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(s);

  function sanitizePoll(p) {
    if (!p || typeof p !== "object") return null;
    const q = str(p.q, LIM.q); if (!q) return null;
    if (!Array.isArray(p.opts)) return null;
    const seen = new Set(), opts = [];
    for (const o of p.opts.slice(0, LIM.opts)) {
      const id = o && idOk(o.id) ? o.id : null, t = str(o && o.t, LIM.opt);
      if (!id || !t || seen.has(id)) continue;
      seen.add(id); opts.push({ id, t });
    }
    if (opts.length < 2) return null;
    const out = { q, opts, multi: !!p.multi, closed: false };
    if (p.pub) out.pub = true; // публичный: видно, кто как проголосовал
    const ca = Number(p.closeAt);
    if (isFinite(ca) && ca > 0 && ca <= Date.now() + 8 * 864e5) out.closeAt = Math.round(ca); // автозакрытие по времени (до 7 дней)
    return out;
  }
  // optIds — полный набор выбранных пунктов этого человека (пустой — снять голос). Возвращает true, если что-то изменилось.
  // at — когда голос подан (для запоздавших офлайн-доставок): после времени автозакрытия голоса не принимаются
  function isClosed(m, at) { return !!(m && m.poll && (m.poll.closed || (m.poll.closeAt && (at || Date.now()) >= m.poll.closeAt))); }
  function applyVote(m, voterId, optIds, at) {
    if (!m || !m.poll || isClosed(m, at) || typeof voterId !== "string" || !voterId) return false;
    if (!Array.isArray(optIds)) return false;
    const valid = new Set(m.poll.opts.map((o) => o.id));
    let ids = Array.from(new Set(optIds.filter((x) => valid.has(x))));
    if (!m.poll.multi) ids = ids.slice(0, 1);
    if (!m.pollVotes || typeof m.pollVotes !== "object") m.pollVotes = {};
    const prev = m.pollVotes[voterId] || [];
    if (prev.length === ids.length && prev.every((x) => ids.includes(x))) return false;
    if (ids.length) m.pollVotes[voterId] = ids; else delete m.pollVotes[voterId];
    m.rv = (m.rv || 0) + 1;
    return true;
  }
  function tally(m) {
    const counts = {}; for (const o of m.poll.opts) counts[o.id] = 0;
    const votes = m.pollVotes || {}; let voters = 0;
    for (const v of Object.values(votes)) { if (!Array.isArray(v) || !v.length) continue; voters++; for (const id of v) if (id in counts) counts[id]++; }
    return { counts, voters };
  }
  function closePoll(m) { if (!m || !m.poll || m.poll.closed) return false; m.poll.closed = true; m.rv = (m.rv || 0) + 1; return true; }

  function sanitizeBoard(b) {
    if (!b || typeof b !== "object") return null;
    const title = str(b.title, LIM.title) || "Board";
    const cols = [], seen = new Set();
    for (const c of (Array.isArray(b.cols) ? b.cols : []).slice(0, LIM.cols)) {
      const id = c && idOk(c.id) ? c.id : null, t = str(c && c.t, LIM.col);
      if (!id || !t || seen.has(id)) continue; seen.add(id); cols.push({ id, t });
    }
    if (cols.length < 1) return null;
    return { title, cols, cards: [], dead: {}, pend: {} };
  }
  // op: { t: "add"|"move"|"edit"|"del", card?: {id,t,col}, id?, col?, text? }, ts — время операции у автора.
  // У карточки раздельные метки времени колонки (cu) и текста (tu); операции над ещё не пришедшей карточкой ждут в b.pend.
  function applyBoardOp(m, op, ts) {
    if (!m || !m.board || !op || typeof op !== "object") return false;
    const b = m.board; ts = Number(ts) || 0;
    if (!b.dead || typeof b.dead !== "object") b.dead = {};
    if (!b.pend || typeof b.pend !== "object") b.pend = {};
    const colOk = (c) => b.cols.some((x) => x.id === c);
    const find = (id) => b.cards.find((c) => c.id === id);
    const setCol = (c, col, t) => { if (!colOk(col) || t < c.cu || c.col === col && t <= c.cu) return false; c.col = col; c.cu = t; return true; };
    const setText = (c, text, t) => { text = str(text, LIM.card); if (!text || t < c.tu || c.t === text && t <= c.tu) return false; c.t = text; c.tu = t; return true; };
    const stash = (id, o) => {
      if (!idOk(id) || b.dead[id]) return;
      const list = b.pend[id] || (b.pend[id] = []);
      if (list.length < 8) list.push(o);
      const keys = Object.keys(b.pend); if (keys.length > 100) delete b.pend[keys[0]];
    };
    let changed = false;
    if (op.t === "add") {
      const c = op.card; if (!c || !idOk(c.id) || b.dead[c.id] || find(c.id) || !colOk(c.col)) return false;
      const t = str(c.t, LIM.card); if (!t || b.cards.length >= LIM.cards) return false;
      const card = { id: c.id, t, col: c.col, cu: ts, tu: ts };
      b.cards.push(card); changed = true;
      for (const p of (b.pend[c.id] || [])) { if (p.t === "move") setCol(card, p.col, p.ts); else if (p.t === "edit") setText(card, p.text, p.ts); }
      delete b.pend[c.id];
    } else if (op.t === "move") {
      const c = find(op.id); if (!c) { stash(op.id, { t: "move", col: op.col, ts }); return false; }
      changed = setCol(c, op.col, ts);
    } else if (op.t === "edit") {
      const c = find(op.id); if (!c) { stash(op.id, { t: "edit", text: op.text, ts }); return false; }
      changed = setText(c, op.text, ts);
    } else if (op.t === "colname") {
      const col = b.cols.find((x) => x.id === op.col), name = str(op.name, LIM.col);
      if (!col || !name || ts < (col.tn || 0) || col.t === name && ts <= (col.tn || 0)) return false;
      col.t = name; col.tn = ts; changed = true;
    } else if (op.t === "del") {
      if (!idOk(op.id)) return false;
      const i = b.cards.findIndex((c) => c.id === op.id);
      if (i >= 0) { b.cards.splice(i, 1); changed = true; }
      if (!b.dead[op.id]) { b.dead[op.id] = ts; changed = true; }
      delete b.pend[op.id];
      const keys = Object.keys(b.dead); if (keys.length > LIM.dead) for (const k of keys.slice(0, keys.length - LIM.dead)) delete b.dead[k];
    }
    if (changed) m.rv = (m.rv || 0) + 1;
    return changed;
  }
  const api = { LIM, isClosed, sanitizePoll, applyVote, tally, closePoll, sanitizeBoard, applyBoardOp };
  root.EtherRich = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
