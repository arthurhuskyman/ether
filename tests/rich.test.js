// Опросы и доски: очистка чужих данных, подсчёт, сходимость операций.
const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../js/rich.js");

const poll = (multi) => ({ poll: R.sanitizePoll({ q: "Где обедаем?", multi, opts: [{ id: "a", t: "Суши" }, { id: "b", t: "Пицца" }, { id: "c", t: "Борщ" }] }) });

test("опрос: очистка чужого ввода", () => {
  assert.equal(R.sanitizePoll(null), null);
  assert.equal(R.sanitizePoll({ q: "", opts: [] }), null);
  assert.equal(R.sanitizePoll({ q: "x", opts: [{ id: "a", t: "один" }] }), null, "меньше двух пунктов");
  const p = R.sanitizePoll({ q: "  q\u0000  ", opts: [{ id: "a", t: "A" }, { id: "a", t: "дубль" }, { id: "b!", t: "плохой id" }, { id: "b", t: "B" }, ...Array.from({ length: 20 }, (_, i) => ({ id: "x" + i, t: "t" }))] });
  assert.equal(p.q, "q"); assert.deepEqual(p.opts.map((o) => o.id).slice(0, 2), ["a", "b"]); assert.ok(p.opts.length <= R.LIM.opts);
});

test("голоса: один выбор заменяется, множественный копится, закрытый опрос не принимает", () => {
  const m = poll(false);
  assert.equal(R.applyVote(m, "u1", ["a"]), true);
  assert.equal(R.applyVote(m, "u1", ["a"]), false, "тот же голос — без изменений");
  R.applyVote(m, "u1", ["b", "c"]); // не multi → берётся первый
  R.applyVote(m, "u2", ["b"]);
  R.applyVote(m, "u3", ["zzz"]); // несуществующий пункт
  const t = R.tally(m);
  assert.deepEqual(t.counts, { a: 0, b: 2, c: 0 }); assert.equal(t.voters, 2);
  R.applyVote(m, "u2", []);
  assert.equal(R.tally(m).voters, 1, "пустой набор снимает голос");
  const mm = poll(true); R.applyVote(mm, "u1", ["a", "c"]);
  assert.deepEqual(R.tally(mm).counts, { a: 1, b: 0, c: 1 });
  assert.equal(R.closePoll(mm), true); assert.equal(R.closePoll(mm), false);
  assert.equal(R.applyVote(mm, "u9", ["a"]), false);
});

const board = () => ({ board: R.sanitizeBoard({ title: "План", cols: [{ id: "todo", t: "To do" }, { id: "doing", t: "Doing" }, { id: "done", t: "Done" }] }) });

test("доска: добавить / переместить / править / удалить", () => {
  const m = board();
  assert.equal(R.applyBoardOp(m, { t: "add", card: { id: "k1", t: "Купить", col: "todo" } }, 10), true);
  assert.equal(R.applyBoardOp(m, { t: "add", card: { id: "k1", t: "дубль", col: "todo" } }, 11), false);
  assert.equal(R.applyBoardOp(m, { t: "add", card: { id: "k2", t: "в никуда", col: "nope" } }, 11), false);
  assert.equal(R.applyBoardOp(m, { t: "move", id: "k1", col: "doing" }, 20), true);
  assert.equal(R.applyBoardOp(m, { t: "edit", id: "k1", text: "Купить хлеб" }, 30), true);
  assert.equal(m.board.cards[0].t, "Купить хлеб"); assert.equal(m.board.cards[0].col, "doing");
  assert.equal(R.applyBoardOp(m, { t: "del", id: "k1" }, 40), true);
  assert.equal(m.board.cards.length, 0);
});

test("доска: операции в любом порядке дают одно состояние; удалённая карточка не воскресает", () => {
  const ops = [
    [{ t: "add", card: { id: "k1", t: "A", col: "todo" } }, 10],
    [{ t: "move", id: "k1", col: "doing" }, 20],
    [{ t: "move", id: "k1", col: "done" }, 30],
    [{ t: "edit", id: "k1", text: "A2" }, 25],
    [{ t: "add", card: { id: "k2", t: "B", col: "todo" } }, 12],
    [{ t: "del", id: "k2" }, 50]
  ];
  // все 720 перестановок дают одно и то же
  const run = (order) => { const m = board(); for (const i of order) R.applyBoardOp(m, ops[i][0], ops[i][1]); return JSON.stringify(m.board.cards.map((c) => [c.id, c.t, c.col])); };
  const base = run([0, 1, 2, 3, 4, 5]);
  const perms = (a) => a.length < 2 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p]));
  for (const p of perms([0, 1, 2, 3, 4, 5])) assert.equal(run(p), base, "порядок " + p.join(""));
  assert.equal(base, JSON.stringify([["k1", "A2", "done"]]));
  const m = board(); R.applyBoardOp(m, ops[5][0], ops[5][1]); R.applyBoardOp(m, ops[4][0], ops[4][1]);
  assert.equal(m.board.cards.length, 0, "надгробие");
});

test("доска: лимиты и мусор", () => {
  assert.equal(R.sanitizeBoard({ cols: [] }), null);
  const m = board();
  for (let i = 0; i < 150; i++) R.applyBoardOp(m, { t: "add", card: { id: "c" + i, t: "t", col: "todo" } }, i);
  assert.equal(m.board.cards.length, R.LIM.cards);
  assert.equal(R.applyBoardOp(m, null, 1), false); assert.equal(R.applyBoardOp(m, { t: "boom" }, 1), false);
  assert.equal(R.applyBoardOp({}, { t: "del", id: "x" }, 1), false);
});
