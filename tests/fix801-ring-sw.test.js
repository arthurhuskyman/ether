// V.80.1 (копия загрузчика fix79): service worker — серия «гудков» web-push, отмена, push-ack, правило видимого окна, клик (docs/CALL-RELIABILITY-PROTOCOL.md A/B/C/D).
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

const hybridRing = (o) => ({ web_push: 8030, mutable: true, notification: { title: "📞 Аня", body: "Входящий вызов", navigate: "https://x.test/#answer=c1abcdef&from=peer1", tag: "ring-c1abcdef", silent: false, lang: "ru", data: Object.assign({ t: "call-ring", callId: "c1abcdef", seq: 1, total: 6, from: "peer1", name: "Аня", video: false, ackToken: "tok1" }, o) } });
const hybridCancel = (reason) => ({ web_push: 8030, mutable: true, notification: { title: "Пропущенный звонок", tag: "ring-c1abcdef", data: { t: "call-cancel", callId: "c1abcdef", reason, from: "peer1", name: "Аня" } } });

test("гибридный call-ring (declarative+mutable): тот же путь, что raw — ack, tag ring-<id>, данные", async () => {
  const t = load({ clients: [] });
  await push(t, hybridRing());
  assert.equal(t.shown.length, 1); assert.equal(t.shown[0].tag, "ring-c1abcdef"); assert.equal(t.shown[0].data.callId, "c1abcdef"); assert.equal(t.shown[0].data.ring, true);
  assert.equal(t.fetches.length, 1); assert.deepEqual(JSON.parse(t.fetches[0].init.body), { callId: "c1abcdef", seq: 1, ackToken: "tok1" });
  await push(t, hybridRing({ seq: 2 }));
  assert.equal(t.live().length, 1, "повторный гудок не копится");
});

test("гибридный call-cancel закрывает гудок и показывает «пропущенный»; answered — тихо «завершён»", async () => {
  const t = load({ clients: [] });
  await push(t, hybridRing());
  await push(t, hybridCancel("cancelled"));
  assert.ok(t.closed.includes("ring-c1abcdef"));
  assert.ok(t.shown.some((n) => n.tag === "missed-c1abcdef"));
  const u = load({ clients: [] });
  await push(u, hybridRing()); await push(u, hybridCancel("answered"));
  assert.ok(u.shown.some((n) => n.tag === "ended-c1abcdef" && n.silent === true));
});

test("гибридный звонок от заблокированного подавляется, как raw", async () => {
  const b = load({ clients: [], meta: { "./__blocked.json": JSON.stringify(["peer1"]) } });
  await push(b, hybridRing());
  assert.equal(b.shown.length, 0); assert.equal(b.fetches.length, 0);
});

test("declarative-сообщение (mutable:true): SW читает notification.*, показывает с tag/navigate; заблокированный контакт подавлен", async () => {
  const msg = { web_push: 8030, mutable: true, notification: { title: "Алиса", body: "Новое сообщение", tag: "ether-msg-alice", navigate: "https://x.test/?chat=alice", data: { contactId: "alice", kind: "message", navigate: "https://x.test/?chat=alice" } } };
  const t = load({ clients: [] });
  await push(t, msg);
  assert.equal(t.shown.length, 1); assert.equal(t.shown[0].title, "Алиса"); assert.equal(t.shown[0].tag, "ether-msg-alice"); assert.equal(t.shown[0].data.navigate, "https://x.test/?chat=alice");
  const b = load({ clients: [], meta: { "./__blocked.json": JSON.stringify(["alice"]) } });
  let closedByEvent = 0;
  const ev = { data: { json: () => msg }, notification: { close() { closedByEvent++; } }, waitUntil: (x) => { b._p = Promise.all([b._p, x]); } };
  b.handlers.push(ev); await b._p;
  assert.equal(b.shown.length, 0, "заблокирован: SW ничего не показывает");
  assert.equal(closedByEvent, 1, "и закрывает event.notification, если платформа его дала");
});

test("raw-legacy сообщение (без notification) по-прежнему показывается", async () => {
  const t = load({ clients: [] });
  await push(t, { title: "Боб", body: "hi", tag: "ether-msg-bob", data: { contactId: "bob", kind: "message" } });
  assert.equal(t.shown.length, 1); assert.equal(t.shown[0].title, "Боб");
});
