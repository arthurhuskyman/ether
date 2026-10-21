// M1/M3/M4: service worker — activate чистит только старые ether-shell-*, SHELL_FILES не перезаписываются фоном, Range → 206.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");
const src = fs.readFileSync(path.join(__dirname, "..", "sw.js"), "utf8");

function load(cacheNames, files) {
  const handlers = {}, puts = [], deleted = [];
  const store = new Map(Object.entries(files || {}));
  const caches = {
    keys: async () => cacheNames.slice(),
    delete: async (k) => { deleted.push(k); return true; },
    open: async () => ({ put: async (req, res) => { puts.push(typeof req === "string" ? req : req.url); } }),
    match: async (req) => store.get(typeof req === "string" ? req : req.url) || undefined,
  };
  const self = { location: new URL("https://x.test/"), addEventListener: (t, f) => { handlers[t] = f; }, clients: { claim() {} } };
  const ctx = { self, caches, location: self.location, URL, Response, Headers, fetch: async () => new Response("net", { status: 200 }), console, Promise };
  ctx.fetch = ctx.fetch.bind(null);
  vm.runInNewContext(src, ctx);
  return { handlers, puts, deleted, ctx };
}
const req = (url, range) => ({ method: "GET", url, mode: "no-cors", headers: { get: (h) => (h.toLowerCase() === "range" ? range || null : null) } });
const fire = async (h, ev) => { let p; ev.respondWith = (x) => { p = x; }; ev.waitUntil = (x) => { p = x; }; h(ev); return p; };

test("M1: activate удаляет только старые ether-shell-*; transformers-cache и ether-meta живут", async () => {
  const cur = /CACHE_VERSION = "([^"]+)"/.exec(src)[1];
  const t = load([cur, "ether-shell-v1", "ether-shell-v100", "ether-meta", "transformers-cache"]);
  await fire(t.handlers.activate, {});
  assert.deepEqual(t.deleted.sort(), ["ether-shell-v1", "ether-shell-v100"]);
});

test("M3: фоновый cache.put не пишет SHELL_FILES, но пишет прочее (runtime)", async () => {
  const t = load([]);
  t.ctx.fetch = async () => { const r = new Response("x", { status: 200 }); Object.defineProperty(r, "type", { value: "basic" }); return r; };
  await fire(t.handlers.fetch, { request: req("https://x.test/js/devices.js") });
  await fire(t.handlers.fetch, { request: req("https://x.test/css/skins/neon.css") });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(t.puts, ["https://x.test/css/skins/neon.css"]);
});

test("M4: Range из кэша → 206 с Content-Range; суффикс; 416 за пределами", async () => {
  const body = new Uint8Array(100).map((_, i) => i);
  const cached = () => new Response(body, { status: 200, headers: { "Content-Type": "audio/mpeg" } });
  const url = "https://x.test/sounds/msg.mp3";
  const t = load([], { [url]: cached() });
  let r = await fire(t.handlers.fetch, { request: req(url, "bytes=10-19") });
  assert.equal(r.status, 206); assert.equal(r.headers.get("Content-Range"), "bytes 10-19/100");
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  t.ctx.caches.match = async () => cached();
  r = await fire(t.handlers.fetch, { request: req(url, "bytes=0-") });
  assert.equal(r.status, 206); assert.equal(r.headers.get("Content-Range"), "bytes 0-99/100");
  t.ctx.caches.match = async () => cached();
  r = await fire(t.handlers.fetch, { request: req(url, "bytes=-5") });
  assert.equal(r.headers.get("Content-Range"), "bytes 95-99/100");
  t.ctx.caches.match = async () => cached();
  r = await fire(t.handlers.fetch, { request: req(url, "bytes=500-600") });
  assert.equal(r.status, 416);
});
