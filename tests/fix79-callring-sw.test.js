// V.79: service worker — серия «гудков» web-push, отмена, push-ack, правило видимого окна, клик (docs/CALL-RELIABILITY-PROTOCOL.md A/B/C/D).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");
const src = fs.readFileSync(path.join(__dirname, "..", "sw.js"), "utf8");

function load(opts) {
  opts = opts || {};
  const handlers = {}, shown = [], closed = [], fetches = [], posts = [], opened = [], focused = [];
  const meta = new Map(Object.entries(opts.meta || {}));
  let live = []; // «открытые» уведомления
  const caches = {
    keys: async () => [], delete: async () => true,
    open: async () => ({ put: async (req, res) => { meta.set(typeof req === "string" ? req : req.url, await res.text()); }, match: async (req) => { const k = typeof req === "string" ? req : req.url; return meta.has(k) ? new Response(meta.get(k)) : undefined; } }),
    match: async () => undefined,
  };
  const mkClient = (vis) => ({ visibilityState: vis, focus() { focused.push(vis); return Promise.resolve(); }, postMessage(m) { posts.push(m); } });
  const clients = { claim() {}, matchAll: async () => (opts.clients || []).map((v) => mkClient(v)), openWindow: async (u) => { opened.push(u); } };
  const registration = {
    scope: opts.scope || "https://x.test/",
    getNotifications: async () => live.slice(),
    showNotification: async (title, o) => { const n = { title, ...o, close() { closed.push(n.tag); live = live.filter((x) => x !== n); } }; shown.push(n); live.push(n); },
  };
  const self = { location: new URL("https://x.test/sw.js"), addEventListener: (t, f) => { handlers[t] = f; }, clients, registration };
  const ctx = { self, caches, location: self.location, URL, Response, Headers, console, Promise, fetch: async (u, init) => { fetches.push({ url: String(u), init }); return new Response("ok"); } };
  vm.runInNewContext(src, ctx);
  return { handlers, shown, closed, fetches, posts, opened, focused, meta, live: () => live };
}
const pushEv = (obj) => { let p; const ev = { data: { json: () => obj }, waitUntil: (x) => { p = Promise.all([p, x]); } }; return { ev, done: () => p }; };
async function push(t, obj) { const { ev, done } = pushEv(obj); t.handlers.push(ev); await done(); }
const ring = (o) => Object.assign({ t: "call-ring", callId: "c1abcdef", from: "peer1", name: "Аня", seq: 1, total: 6, video: false, ackToken: "tok1" }, o);

test("call-ring: показывает «📞 {name} звонит» с tag ring-<callId>, deep-link и данными; ack отправляется keepalive", async () => {
  const t = load({ clients: [] });
  await push(t, ring());
  assert.equal(t.shown.length, 1);
  const n = t.shown[0];
  assert.equal(n.title, "📞 Аня звонит");
  assert.equal(n.body, "Нажмите, чтобы ответить");
  assert.equal(n.tag, "ring-c1abcdef");
  assert.equal(n.requireInteraction, true);
  assert.equal(n.data.callId, "c1abcdef"); assert.equal(n.data.from, "peer1");
  assert.equal(n.data.url, "/#answer=c1abcdef&from=peer1");
  assert.equal(t.fetches.length, 1);
  assert.match(t.fetches[0].url, /\/push-ack$/);
  assert.equal(t.fetches[0].init.method, "POST"); assert.equal(t.fetches[0].init.keepalive, true);
  assert.deepEqual(JSON.parse(t.fetches[0].init.body), { callId: "c1abcdef", seq: 1, ackToken: "tok1" });
});

test("ack идёт на HTTP-адрес из ring-config; локализованные строки подставляются", async () => {
  const t = load({ clients: [] });
  const msg = { data: { type: "ring-config", httpBase: "https://sig.example/", strings: { ringTitle: "📞 {name} is calling", ringBody: "Tap to answer" } }, waitUntil: () => {} };
  let p; msg.waitUntil = (x) => { p = x; }; t.handlers.message(msg); await p;
  await push(t, ring());
  assert.equal(t.fetches[0].url, "https://sig.example/push-ack");
  assert.equal(t.shown[0].title, "📞 Аня is calling"); assert.equal(t.shown[0].body, "Tap to answer");
});

test("новый гудок того же callId закрывает прежнее уведомление и показывает новое (не копятся)", async () => {
  const t = load({ clients: [] });
  await push(t, ring({ seq: 1 })); await push(t, ring({ seq: 2, ackToken: "tok2" })); await push(t, ring({ seq: 3, ackToken: "tok3" }));
  assert.equal(t.shown.length, 3);
  assert.equal(t.live().length, 1, "в центре уведомлений остаётся одно");
  assert.equal(t.closed.length, 2);
  assert.equal(t.fetches.length, 3);
});

test("видимое окно приложения: уведомление не показывается, но ack уходит и окно получает ring-received; невидимое окно — показываем", async () => {
  const t = load({ clients: ["visible"] });
  await push(t, ring());
  assert.equal(t.shown.length, 0);
  assert.equal(t.fetches.length, 1);
  assert.ok(t.posts.some((m) => m.type === "ring-received" && m.callId === "c1abcdef"));
  const t2 = load({ clients: ["hidden"] });
  await push(t2, ring());
  assert.equal(t2.shown.length, 1, "окно есть, но не видно: тихих push нет");
});

test("без ackToken ack не отправляется; заблокированный отправитель — ни уведомления, ни ack", async () => {
  const t = load({ clients: [] });
  await push(t, ring({ ackToken: undefined }));
  assert.equal(t.fetches.length, 0); assert.equal(t.shown.length, 1);
  const b = load({ clients: [], meta: { "./__blocked.json": JSON.stringify(["peer1"]) } });
  await push(b, ring());
  assert.equal(b.shown.length, 0); assert.equal(b.fetches.length, 0);
});

test("call-cancel timeout/cancelled: закрывает гудок и показывает «Пропущенный звонок от {name}» (имя из закрытого уведомления)", async () => {
  for (const reason of ["cancelled", "timeout"]) {
    const t = load({ clients: [] });
    await push(t, ring());
    await push(t, { t: "call-cancel", callId: "c1abcdef", reason });
    assert.ok(t.closed.includes("ring-c1abcdef"));
    const last = t.shown[t.shown.length - 1];
    assert.equal(last.title, "Пропущенный звонок от Аня");
    assert.equal(last.tag, "missed-c1abcdef");
    assert.equal(last.data.kind, "missed-call"); assert.equal(last.data.contactId, "peer1");
    assert.equal(t.live().length, 1, "остаётся только «пропущенный»");
  }
});

test("call-cancel answered/declined: закрывает гудок и показывает короткое «Звонок завершён»; при видимом окне только закрывает", async () => {
  for (const reason of ["answered", "declined"]) {
    const t = load({ clients: [] });
    await push(t, ring());
    await push(t, { t: "call-cancel", callId: "c1abcdef", reason });
    const last = t.shown[t.shown.length - 1];
    assert.equal(last.title, "Звонок завершён"); assert.equal(last.tag, "ended-c1abcdef"); assert.equal(last.silent, true);
  }
  const v = load({ clients: [] });
  await push(v, ring());
  v.handlers.push; // окно появилось позже
  const v2 = load({ clients: ["visible"] });
  await push(v2, { t: "call-cancel", callId: "zz", reason: "timeout" });
  assert.equal(v2.shown.length, 0);
});

test("cancel без предшествующего гудка (имя из payload) и с чужим callId не закрывает чужие уведомления", async () => {
  const t = load({ clients: [] });
  await push(t, ring({ callId: "other" }));
  await push(t, { t: "call-cancel", callId: "c1abcdef", reason: "timeout", name: "Боря", from: "peer2" });
  assert.equal(t.live().filter((n) => n.tag === "ring-other").length, 1);
  assert.equal(t.shown[t.shown.length - 1].title, "Пропущенный звонок от Боря");
});

test("каждый push записывает отметку времени для «Проверки уведомлений»", async () => {
  const t = load({ clients: [] });
  await push(t, ring());
  const lp = JSON.parse(t.meta.get("./__lastpush.json"));
  assert.equal(lp.t, "call-ring"); assert.ok(Date.now() - lp.ts < 5000);
  await push(t, { notification: { title: "Привет", body: "x", tag: "m", data: { contactId: "a" } } });
  assert.equal(JSON.parse(t.meta.get("./__lastpush.json")).t, "push");
});

test("прежние push (сообщение, звонок kind:call) работают как раньше", async () => {
  const t = load({ clients: [] });
  await push(t, { title: "Аня", body: "Привет", tag: "msg", data: { contactId: "a", kind: "message" } });
  assert.equal(t.shown.length, 1); assert.equal(t.shown[0].title, "Аня");
  assert.equal(t.shown[0].actions[0].action, "reply");
  const v = load({ clients: ["visible"] });
  await push(v, { title: "Аня", body: "Привет", tag: "msg", data: { contactId: "a" } });
  assert.equal(v.shown.length, 0, "видимое окно: как раньше, без уведомления");
});

test("notificationclick по гудку: есть окно → focus + answer-call с deep-link; нет окна → openWindow(/#answer=…)", async () => {
  const t = load({ clients: [] });
  await push(t, ring());
  const n = t.shown[0];
  const click = (tt, notif) => { let p; tt.handlers.notificationclick({ notification: { ...notif, close() {} }, action: "", waitUntil: (x) => { p = x; } }); return p; };
  await click(t, n);
  assert.deepEqual(t.opened, ["/#answer=c1abcdef&from=peer1"]);
  const w = load({ clients: ["hidden"] });
  await push(w, ring());
  await click(w, w.shown[0]);
  assert.equal(w.opened.length, 0);
  assert.equal(w.focused.length, 1);
  const m = w.posts.find((x) => x.type === "answer-call");
  assert.equal(m.callId, "c1abcdef"); assert.equal(m.from, "peer1"); assert.equal(m.url, "/#answer=c1abcdef&from=peer1");
});

test("notificationclick по «пропущенному»: открывает чат через open-contact (прежний путь)", async () => {
  const t = load({ clients: ["hidden"] });
  await push(t, ring()); await push(t, { t: "call-cancel", callId: "c1abcdef", reason: "timeout" });
  const miss = t.shown[t.shown.length - 1];
  let p; t.handlers.notificationclick({ notification: { ...miss, close() {} }, action: "", waitUntil: (x) => { p = x; } }); await p;
  const m = t.posts.find((x) => x.type === "open-contact");
  assert.equal(m.contactId, "peer1"); assert.equal(m.kind, "missed-call");
});

test("deep-link учитывает подпапку scope (GitHub Pages)", async () => {
  const t = load({ clients: [], scope: "https://u.github.io/ether/" });
  await push(t, ring());
  assert.equal(t.shown[0].data.url, "/ether/#answer=c1abcdef&from=peer1");
});
