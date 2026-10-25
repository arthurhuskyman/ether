// V.80: js/integrity.js (проверка загруженных файлов по подписанному манифесту), Центр безопасности, sw.js (отказ в обновлении без верной подписи).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm"), crypto = require("crypto");
const { createApp, closeAll } = require("./harness");
const L = require("../tools/release-lib.js");
test.after(closeAll);
const ROOT = path.resolve(__dirname, "..");

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const j = publicKey.export({ format: "jwk" });
  return { pem: privateKey.export({ type: "pkcs8", format: "pem" }), jwk: { kty: j.kty, crv: j.crv, x: j.x, y: j.y } };
}
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, arrayBuffer: async () => { const b = Buffer.from(body); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } });
// Сервер: отдаёт «загруженные» файлы (их содержимое — свой текст на путь) и подписанный манифест
function server(kp, opts) {
  opts = opts || {};
  const content = {};
  const self = {
    content,
    build(paths) {
      for (const p of paths) if (!(p in content)) content[p] = "content of " + p;
      const files = {}; for (const p of paths) files[p] = L.sha256hex(Buffer.from(content[p]));
      const mBytes = Buffer.from(L.serialize({ v: 1, version: "V.test", ts: "T", files }));
      this.manifest = mBytes; this.sig = Buffer.from(JSON.stringify({ v: 1, sig: L.b64u(L.signBytes(kp.pem, mBytes)) }));
    },
    fetch: async (url, init) => {
      const u = new URL(url), name = u.pathname.replace(/^\//, "");
      if (name === "release-manifest.json") return opts.noManifest ? res(404, "") : res(200, opts.manifest || self.manifest || server.cur.manifest);
      if (name === "release-manifest.sig.json") return opts.noSig ? res(404, "") : res(200, opts.sig || self.sig || server.cur.sig);
      if (opts.offline) throw new TypeError("offline");
      const key = name === "" ? "index.html" : name;
      return key in self.content ? res(200, self.content[key]) : res(404, "");
    },
  };
  return self;
}
function loadedPaths(app) {
  for (const f of ["js/bundle.core.js", "js/bundle.app.js", "js/release-key.js"]) { const sc = app.document.createElement("script"); sc.setAttribute("src", f); app.document.head.appendChild(sc); } // harness исполняет скрипты сам и убирает теги из DOM
  return Object.keys(app.window.Integrity.loadedFiles(app.document, "http://localhost/")); }

test("ключ не настроен (release-key.js = null): состояние unconfigured без сети и без ошибки", async () => {
  const a = createApp({ fetch: async () => { throw new Error("сеть не должна вызываться"); } });
  assert.equal(a.window.RELEASE_PUBKEY, null);
  const st = await a.window.Integrity.check();
  assert.equal(st.status, "unconfigured");
  a.close();
});

test("verified / mismatch / unsigned / offline / плохая подпись", async () => {
  const a = createApp(), I = a.window.Integrity, kp = keypair(), other = keypair();
  const paths = loadedPaths(a);
  assert.ok(paths.includes("index.html") && paths.includes("sw.js") && paths.includes("js/bundle.core.js") && paths.includes("css/styles.css"), paths.join());
  const srv = server(kp); server.cur = srv; srv.build(paths);
  const opt = (s, extra) => Object.assign({ key: kp.jwk, fetch: s.fetch, document: a.document, baseHref: "http://localhost/", updatePending: false }, extra);
  assert.equal((await I.check(opt(srv))).status, "verified");
  assert.equal(I.state.checked, paths.length);
  // файл подменили на сервере (манифест прежний)
  srv.content["js/bundle.app.js"] = "evil";
  let st = await I.check(opt(srv)); assert.equal(st.status, "mismatch"); assert.deepEqual(Array.from(st.diffs), ["js/bundle.app.js"]);
  srv.content["js/bundle.app.js"] = "content of js/bundle.app.js";
  // манифест подписан чужим ключом
  assert.equal((await I.check(opt(srv, { key: other.jwk }))).status, "mismatch");
  // манифест изменён после подписания
  const tampered = server(kp); tampered.build(paths); tampered.manifest = Buffer.from(tampered.manifest.toString().replace("V.test", "V.evil"));
  server.cur = tampered; st = await I.check(opt(tampered)); assert.equal(st.status, "mismatch"); assert.deepEqual(Array.from(st.diffs), ["signature"]);
  // файл есть на странице, но не в манифесте
  const partial = server(kp); partial.build(paths.filter((p) => p !== "sw.js")); partial.content["sw.js"] = "x"; server.cur = partial;
  st = await I.check(opt(partial)); assert.equal(st.status, "mismatch"); assert.ok(st.diffs[0].startsWith("sw.js"));
  // манифеста/подписи нет -> unsigned; сеть упала -> offline
  server.cur = srv;
  assert.equal((await I.check(opt(srv, {}))).status, "verified");
  assert.equal((await I.check(opt(server(kp, { noManifest: true })))).status, "unsigned");
  assert.equal((await I.check(opt(server(kp, { noSig: true })))).status, "unsigned");
  assert.equal((await I.check(opt({ fetch: async () => { throw new TypeError("offline"); } }))).status, "offline");
  assert.equal((await I.check(opt({ fetch: async () => res(503, "") }))).status, "offline");
  // мусор вместо подписи/манифеста не бросает
  server.cur = srv;
  const withSig = (sig) => { const s2 = server(kp, { sig }); s2.manifest = srv.manifest; s2.content = srv.content; server.cur = s2; return s2; };
  assert.equal((await I.check(opt(withSig(Buffer.from("not json"))))).status, "unsigned");
  assert.equal((await I.check(opt(withSig(Buffer.from("{}"))))).status, "mismatch");
  a.close();
});

test("Центр безопасности: шторка, состояние, список защищено/не защищено, проверка контактов, слот серверов, aria", async () => {
  const a = createApp(); await a.ready;
  a.run(`ensureContactEntry("alice","Alice"); ensureContactEntry("bob","Bob"); state.contacts.get("alice").publicKey = {kty:"EC",crv:"P-256",x:"a",y:"b"}; state.contacts.get("alice").verifiedKey = state.contacts.get("alice").publicKey; state.contacts.get("bob").publicKey = {kty:"EC",crv:"P-256",x:"c",y:"d"};`);
  const btn = a.document.getElementById("settings-security-btn"); assert.ok(btn); assert.ok(btn.closest("[data-settings-adv]"), "в простом режиме под «Дополнительно»");
  assert.ok(btn.getAttribute("aria-label"));
  btn.click(); await new Promise((r) => setTimeout(r, 100));
  const sheet = a.document.getElementById("security-sheet");
  assert.ok(!sheet.classList.contains("hidden")); assert.equal(sheet.getAttribute("role"), "dialog"); assert.ok(sheet.getAttribute("aria-labelledby"));
  const body = a.document.getElementById("security-body");
  assert.match(body.textContent, /V\.\d+/);
  assert.equal(a.document.getElementById("security-state").dataset.state, "unconfigured");
  assert.match(a.document.getElementById("security-state").textContent, /Not configured|Не настроено/);
  const lists = body.querySelectorAll("ul.security-list"); assert.equal(lists.length, 2);
  assert.equal(lists[0].children.length, a.window.Integrity.PROTECTS); assert.equal(lists[1].children.length, a.window.Integrity.NOT_PROTECTS);
  assert.match(a.document.getElementById("security-contacts").textContent, /1.*2/);
  assert.ok(a.document.getElementById("security-servers-slot"));
  assert.ok(a.document.getElementById("security-policy-link").getAttribute("aria-label"));
  assert.ok(a.document.getElementById("security-check-btn").getAttribute("aria-label"));
  for (const el of body.querySelectorAll("section")) assert.ok(el.getAttribute("aria-labelledby") && a.document.getElementById(el.getAttribute("aria-labelledby")));
  // сообщение от SW об отклонённом обновлении
  a.window.Integrity.onUpdateRejected({ reason: "bad signature" });
  assert.match(a.document.getElementById("security-body").textContent, /Update failed|Обновление не прошло проверку подписи|The update failed the signature check/);
  a.close();
});

test("строки Центра безопасности: только en+ru, ключи сводки совпадают с docs/THREAT-MODEL.md", () => {
  const dict = (code) => { const d = {}; new Function("window", fs.readFileSync(path.join(ROOT, "js/lang", code + ".js"), "utf8"))({ __LANG_DICTS: d }); return d[code]; };
  const en = dict("en"), ru = dict("ru"), I = { P: 5, N: 7 };
  const keys = Object.keys(en).filter((k) => k.startsWith("security."));
  assert.deepEqual(keys.sort(), Object.keys(ru).filter((k) => k.startsWith("security.")).sort());
  for (let i = 1; i <= I.P; i++) assert.ok(en["security.protect." + i] && ru["security.protect." + i]);
  for (let i = 1; i <= I.N; i++) assert.ok(en["security.not." + i] && ru["security.not." + i]);
  const doc = fs.readFileSync(path.join(ROOT, "docs/THREAT-MODEL.md"), "utf8");
  for (let i = 1; i <= I.P; i++) assert.ok(doc.includes("`security.protect." + i + "`"), "в THREAT-MODEL нет security.protect." + i);
  for (let i = 1; i <= I.N; i++) assert.ok(doc.includes("`security.not." + i + "`"), "в THREAT-MODEL нет security.not." + i);
  // абсолютных обещаний в сводке нет
  for (const k of keys) assert.ok(!/\b(100%|unhackable|impossible|guarantee|абсолютно|невозможно взломать|гарантируем)\b/i.test(en[k] + ru[k]), k);
});

// ---------- service worker ----------
const swSrc = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
const SHELL = [...swSrc.slice(swSrc.indexOf("SHELL_FILES"), swSrc.indexOf("];")).matchAll(/"\.\/([^"]*)"/g)].map((m) => m[1]);
function loadSw(opts) {
  const handlers = {}, puts = [], posted = [], meta = new Map(Object.entries(opts.meta || {}));
  const bodies = opts.bodies;
  const cacheObj = { put: async (req) => { puts.push(typeof req === "string" ? req : req.url); } };
  const caches = {
    keys: async () => [], delete: async () => true,
    open: async (n) => (n === "ether-meta" ? { put: async (k, r) => { meta.set(k, await r.text()); }, match: async (k) => (meta.has(k) ? new Response(meta.get(k)) : undefined) } : cacheObj),
    match: async () => undefined,
  };
  const self = { location: new URL("https://x.test/"), addEventListener: (t, f) => { handlers[t] = f; }, clients: { claim() {}, matchAll: async () => [{ postMessage: (m) => posted.push(m) }] } };
  const fetchFn = async (u) => {
    const url = new URL(String(u), "https://x.test/"), name = url.pathname.replace(/^\//, "") || "index.html";
    if (name === "release-manifest.json") return opts.manifest ? new Response(opts.manifest) : new Response("", { status: 404 });
    if (name === "release-manifest.sig.json") return opts.sig ? new Response(opts.sig) : new Response("", { status: 404 });
    return name in bodies ? new Response(bodies[name]) : new Response("", { status: 404 });
  };
  const ctx = { self, caches, location: self.location, URL, Response, Headers, fetch: fetchFn, console, Promise, crypto: crypto.webcrypto, atob, TextDecoder, Uint8Array };
  if (opts.key !== undefined) ctx.importScripts = () => { self.RELEASE_PUBKEY = opts.key; };
  vm.runInNewContext(swSrc, ctx);
  return { handlers, puts, posted, meta, install: async () => { let p; handlers.install({ waitUntil: (x) => { p = x; } }); return p; } };
}
function swFixture(kp, tamper) {
  const bodies = {}; for (const f of SHELL) bodies[f === "" ? "index.html" : f] = "body of " + f;
  const files = {}; for (const f of SHELL) { const n = f === "" ? "index.html" : f; files[n] = L.sha256hex(Buffer.from(bodies[n])); }
  const m = Buffer.from(L.serialize({ v: 1, version: "t", ts: "t", files })), sig = JSON.stringify({ v: 1, sig: L.b64u(L.signBytes(kp.pem, m)) });
  if (tamper) bodies[tamper] = "evil";
  return { bodies, manifest: m, sig };
}

test("sw: ключа нет -> установка как раньше (всё кладётся в кэш, манифест не читается)", async () => {
  const bodies = {}; for (const f of SHELL) bodies[f === "" ? "index.html" : f] = "x";
  const t = loadSw({ bodies });
  await t.install();
  assert.equal(t.puts.length, SHELL.length); assert.equal(t.posted.length, 0); assert.equal(t.meta.size, 0);
});

test("sw: ключ настроен и подпись/хэши верны -> установка проходит, ключ закрепляется", async () => {
  const kp = keypair(), fx = swFixture(kp);
  const t = loadSw({ key: kp.jwk, bodies: fx.bodies, manifest: fx.manifest, sig: fx.sig });
  await t.install();
  assert.equal(t.puts.length, SHELL.length); assert.equal(t.posted.length, 0);
  assert.ok(t.meta.get("./__relkey.json").includes(kp.jwk.x));
});

test("sw: подменённый файл / чужая подпись / нет манифеста / смена или удаление ключа -> install отклонён, кэш не тронут, страница уведомлена", async () => {
  const kp = keypair(), other = keypair();
  const cases = {
    "подменённый файл": () => { const fx = swFixture(kp, "js/bundle.core.js"); return { key: kp.jwk, bodies: fx.bodies, manifest: fx.manifest, sig: fx.sig }; },
    "чужая подпись": () => { const fx = swFixture(other); return { key: kp.jwk, bodies: fx.bodies, manifest: fx.manifest, sig: fx.sig }; },
    "нет манифеста": () => { const fx = swFixture(kp); return { key: kp.jwk, bodies: fx.bodies }; },
    "ключ сменился": () => { const fx = swFixture(other); return { key: other.jwk, bodies: fx.bodies, manifest: fx.manifest, sig: fx.sig, meta: { "./__relkey.json": JSON.stringify(kp.jwk) } }; },
    "ключ убрали (даунгрейд)": () => { const fx = swFixture(kp); return { bodies: fx.bodies, manifest: fx.manifest, sig: fx.sig, meta: { "./__relkey.json": JSON.stringify(kp.jwk) } }; },
  };
  for (const [name, mk] of Object.entries(cases)) {
    const t = loadSw(mk());
    await assert.rejects(() => t.install(), /release rejected/, name);
    assert.equal(t.puts.length, 0, name + ": в кэш ничего не писали");
    assert.equal(t.posted.length, 1, name); assert.equal(t.posted[0].type, "update-rejected");
  }
});
