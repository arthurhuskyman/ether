// Закрытие находок аудита: эффекты, опросы/доски, SW, групповые звонки.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const R = require("../js/rich.js");
const { bootApp, closeAll } = require("./harness");
test.after(closeAll);
const ROOT = path.join(__dirname, "..");
const J = (x) => JSON.parse(JSON.stringify(x));
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const click = (a, el) => el.dispatchEvent(new a.window.MouseEvent("click", { bubbles: true }));

async function chatApp() {
  const a = await bootApp();
  a.run(`ensureContactEntry("alice","Алиса"); state.contacts.get("alice").publicKey = {kty:"EC", x:"AAA111", y:"BBB222"};`);
  return a;
}
function stubLink(a, id = "alice") {
  const sent = []; a.window.__sent = sent;
  a.run(`(() => { const sent = window.__sent; const l = { id: ${JSON.stringify(id)}, status: "connected", send(p) { sent.push(p); return true; } }; const og = mesh.get.bind(mesh); mesh.get = (x) => x === ${JSON.stringify(id)} ? l : og(x); })()`);
  return sent;
}
const poll = (multi) => ({ poll: R.sanitizePoll({ q: "Q?", multi, opts: [{ id: "a", t: "A" }, { id: "b", t: "B" }] }) });
const board = () => ({ board: R.sanitizeBoard({ title: "B", cols: [{ id: "c1", t: "1" }, { id: "c2", t: "2" }, { id: "c3", t: "3" }] }) });

test("рисование: 'ok' без собственного запроса игнорируется; после запроса принимается один раз", async () => {
  const a = await chatApp();
  stubLink(a);
  a.run(`state.callId = "alice"; state.callPhase = "active"; openCallScreen("alice", "active"); fx2After();`);
  a.run(`handleFxPayload("alice", { kind: "fxdraw", t: "ok" })`);
  assert.equal(a.run(`FXD.active`), false, "непрошеный ok не включает холст");
  a.run(`handleFxPayload("alice", { kind: "fxdraw", t: "s", p: [[0.1,0.1],[0.2,0.2]] })`);
  assert.equal(a.run(`FXD.strokes.length`), 0, "штрихи вне активного режима игнорируются");
  click(a, a.document.querySelector("#fx-draw-btn"));
  assert.equal(a.run(`FXD.asked`), "alice");
  a.run(`FX.set("draw", false)`);
  a.run(`handleFxPayload("alice", { kind: "fxdraw", t: "ok" })`);
  assert.equal(a.run(`FXD.active`), false, "при выключенной настройке ok не принимается");
  a.run(`FX.set("draw", true)`);
  a.run(`handleFxPayload("alice", { kind: "fxdraw", t: "ok" })`);
  assert.equal(a.run(`FXD.active`), true);
  assert.equal(a.run(`FXD.asked`), null);
  a.close();
});

test("костёр: срок из описания чужой группы не удаляет её", async () => {
  const a = await chatApp();
  const desc = "x⁣c:1000000000000⁣";
  a.run(`state.contacts.set("gx", { id: "gx", isGroup: true, name: "Чужая", members: [{id: Store.myId, name: "me"}], messages: [], description: ${JSON.stringify(desc)} })`);
  assert.equal(a.run(`fxCampfireUntil(state.contacts.get("gx"))`), 0);
  assert.equal(a.run(`fxSweepCampfires(Date.now())`), 0);
  assert.equal(a.run(`state.contacts.has("gx")`), true);
  a.close();
});

test("опрос: старый голос не затирает новый при любом порядке доставки", () => {
  for (const order of [[1, 2], [2, 1]]) {
    const m = poll(false); const votes = { 1: ["a"], 2: ["b"] };
    for (const k of order) R.applyVote(m, "u1", votes[k], 1000 * k);
    assert.deepEqual(J(R.tally(m).counts), { a: 0, b: 1 }, "порядок " + order);
  }
  const m = poll(false); R.applyVote(m, "u1", [], 2000); R.applyVote(m, "u1", ["a"], 1000);
  assert.equal(R.tally(m).voters, 0);
  const x = poll(false), y = poll(false);
  R.applyVote(x, "u", ["a"], 5); R.applyVote(x, "u", ["b"], 5);
  R.applyVote(y, "u", ["b"], 5); R.applyVote(y, "u", ["a"], 5);
  assert.deepEqual(J(x.pollVotes), J(y.pollVotes));
  const old = poll(false); old.pollVotes = { u1: ["a"] };
  assert.equal(R.applyVote(old, "u1", ["b"], 10), true);
  assert.deepEqual(J(old.pollVotes.u1), ["b"]);
});

test("доска: отложенные операции очищаются; чужой мусор отбрасывается", () => {
  const m = board();
  R.applyBoardOp(m, { t: "move", id: "k1", col: { evil: 1 } }, 1);
  R.applyBoardOp(m, { t: "move", id: "k1", col: "no spaces!" }, 1);
  R.applyBoardOp(m, { t: "edit", id: "k1", text: { a: 1 } }, 1);
  assert.equal(m.board.pend.k1, undefined);
  R.applyBoardOp(m, { t: "edit", id: "k1", text: "x".repeat(500) }, 1);
  assert.equal(m.board.pend.k1[0].text.length, R.LIM.card);
  R.applyBoardOp(m, { t: "move", id: "k1", col: "c2" }, 2);
  R.applyBoardOp(m, { t: "add", card: { id: "k1", t: "t", col: "c1" } }, 1);
  assert.equal(m.board.cards[0].col, "c2");
});

test("LWW: при равных метках побеждает большее значение, порядок доставки не важен", () => {
  for (const order of [["c2", "c3"], ["c3", "c2"]]) {
    const m = board(); R.applyBoardOp(m, { t: "add", card: { id: "k", t: "t", col: "c1" } }, 5);
    for (const c of order) R.applyBoardOp(m, { t: "move", id: "k", col: c }, 9);
    assert.equal(m.board.cards[0].col, "c3");
  }
  for (const order of [["aaa", "bbb"], ["bbb", "aaa"]]) {
    const m = board(); R.applyBoardOp(m, { t: "add", card: { id: "k", t: "t", col: "c1" } }, 5);
    for (const t of order) R.applyBoardOp(m, { t: "edit", id: "k", text: t }, 9);
    assert.equal(m.board.cards[0].t, "bbb");
  }
  for (const order of [["one", "two"], ["two", "one"]]) {
    const m = { note: R.sanitizeNote({ title: "n", text: "" }) };
    for (const t of order) R.applyNoteOp(m, { t: "set", text: t }, 7);
    assert.equal(m.note.text, "two");
  }
});

test("idOk/tally: зарезервированные имена отвергаются", () => {
  const p = R.sanitizePoll({ q: "q", opts: [{ id: "__proto__", t: "x" }, { id: "constructor", t: "y" }, { id: "a", t: "A" }, { id: "b", t: "B" }] });
  assert.deepEqual(p.opts.map((o) => o.id), ["a", "b"]);
  const t = R.tally({ poll: p, pollVotes: { u: ["__proto__", "constructor", "a"] } });
  assert.deepEqual(J(t.counts), { a: 1, b: 0 });
});

test("sw.js: ether-meta не удаляется при активации, showNotification под waitUntil", () => {
  const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  assert.ok(/k\.startsWith\("ether-shell-"\) && k !== CACHE_VERSION/.test(sw)); // M1: только старые кэши оболочки; ether-meta и transformers-cache не трогаем
  assert.ok(/event\.waitUntil\(self\.registration\.showNotification\(/.test(sw));
});

test("index.html: нет неподдерживаемого data-i18n-placeholder", () => {
  assert.equal(fs.readFileSync(path.join(ROOT, "index.html"), "utf8").includes("data-i18n-placeholder"), false);
});

test("голосовая комната: флаг room от не-админа игнорируется, от админа принимается", async () => {
  const a = await bootApp({ storage: { "ether.myId": "me", "ether.name": "Me" } });
  a.run(`state.contacts.set("g1", { id: "g1", isGroup: true, name: "T", createdBy: "adm", members: [{id:"me",name:"Me"},{id:"adm",name:"Adm",role:"admin"},{id:"bob",name:"Bob"}], messages: [] })`);
  a.run(`roomHandle("bob", { t: "presence", room: true, on: true }, state.contacts.get("g1"))`);
  assert.equal(!!a.run(`state.contacts.get("g1").room`), false);
  a.run(`roomHandle("adm", { t: "presence", room: true, on: true }, state.contacts.get("g1"))`);
  assert.equal(a.run(`state.contacts.get("g1").room`), true);
  a.close();
});

test("групповой звонок: двойной вход не течёт потоком; камера после завершения; трек без join", async () => {
  const a = await bootApp({ storage: { "ether.myId": "me", "ether.name": "Me" } });
  a.run(`state.contacts.set("g1", { id: "g1", isGroup: true, name: "T", createdBy: "me", members: [{id:"me",name:"Me"},{id:"bob",name:"Bob"}], messages: [] });
    window.__made = []; window.__gate = null;
    const mk = () => { const tr = { kind: "audio", stopped: false, stop() { this.stopped = true; }, enabled: true }; const s = { _t: [tr], getTracks() { return this._t; }, getAudioTracks() { return this._t; }, getVideoTracks() { return this._t.filter((t) => t.kind === "video"); }, addTrack(t) { this._t.push(t); }, removeTrack() {} }; window.__made.push(s); return s; };
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => { if (window.__gate) await window.__gate; return mk(); } } });`);
  a.run(`joinGroupCall("g1"); joinGroupCall("g1");`);
  await tick(50);
  assert.equal(a.run(`window.__made.length`), 1, "второй тап не запрашивает второй поток");
  assert.equal(a.run(`GC.gid`), "g1");
  a.run(`gcallAcquire(false)`); await tick(50);
  assert.equal(a.run(`GC.stream === window.__made[0]`), true, "исходный поток не затёрт");
  assert.equal(a.run(`window.__made[1].getTracks()[0].stopped`), true, "лишний поток остановлен");
  a.run(`gcallOnRemoteTrack({ detail: { id: "bob", stream: {}, track: null } })`);
  assert.equal(a.run(`GC.peers.has("bob")`), false, "трек без join не делает участником");
  a.run(`window.__gate = new Promise((r) => { window.__open = r; }); window.__camP = gcallToggleCamera();`);
  a.run(`leaveGroupCall({ silent: true })`);
  a.run(`window.__open()`);
  await a.run(`window.__camP`);
  assert.equal(a.run(`window.__made[window.__made.length - 1].getTracks()[0].stopped`), true, "камера выключена, ошибки нет");
  a.close();
});
