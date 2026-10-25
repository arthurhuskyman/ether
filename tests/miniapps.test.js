// Мини-приложения (js/miniapps.js, miniapps/*): манифесты, права моста, входящее состояние, изоляция iframe, один пункт в меню вложений.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const ROOT = path.join(__dirname, "..");
globalThis.__MINIAPPS_NO_AUTOINIT = true;
const MA = require(path.join(ROOT, "js", "miniapps.js"));

function mkEnv(over) {
  const dom = new JSDOM(`<!doctype html><html lang="en"><head></head><body><div id="composer-menu-sheet" class="sheet"><div class="sheet-actions composer-menu-actions"><button id="chat-poll-btn"></button><button id="composer-menu-more"></button></div></div></body></html>`, { url: "https://example.test/ether/" });
  const w = dom.window; w.MessageChannel = MessageChannel;
  const store = new Map(), sent = [], toasts = [];
  const contacts = new Map([["bob", { id: "bob", name: "Bob" }], ["blocked", { id: "blocked", name: "X", blocked: true }]]);
  let confirms = [], answer = true, t = (globalThis.__maClock = (globalThis.__maClock || 1000) + 100000);
  const e = {
    win: w, doc: w.document, lang: () => "en",
    rd: (k) => (store.has(k) ? JSON.parse(store.get(k)) : {}), wr: (k, o) => { store.set(k, JSON.stringify(o)); return true; },
    toast: (s) => toasts.push(s), confirm: async (msg, ok) => { confirms.push([msg, ok]); return answer; },
    chatId: () => "bob", contact: (id) => contacts.get(id) || null, container: (from) => contacts.get(from) || null, name: (id) => (contacts.get(id) || {}).name || "",
    sendRich: async (c, p) => sent.push(["rich", c.id, p]), sendText: async (c, tx) => sent.push(["text", c.id, tx]), now: () => t, uuid: () => "u" + sent.length,
  };
  Object.assign(e, over || {});
  MA._setEnv(e); MA._sessions.clear();
  return { e, w, dom, store, sent, toasts, confirms: () => confirms, setAnswer: (v) => { answer = v; }, tick: (ms) => { t += ms; } };
}

test("манифесты встроенных приложений валидны, файлы существуют, страницы без inline-скриптов и с закрытым CSP", () => {
  assert.equal(MA.BUILTIN.length, 2);
  for (const m of MA.BUILTIN) {
    assert.deepEqual(MA.validateManifest(m), { ok: true }, m.id);
    const html = fs.readFileSync(path.join(ROOT, m.entry), "utf8");
    assert.match(html, /Content-Security-Policy" content="default-src 'none'; script-src 'self'/);
    assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>/.test(html), "inline-скрипт запрещён CSP: " + m.id);
    assert.ok(!/(https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(html.replace(/<meta[^>]*>/g, "")), "внешних адресов нет");
    assert.ok(!/<form[\s>]/i.test(html), "в песочнице нет allow-forms: отправка формы блокируется — используйте кнопки: " + m.id);
    for (const f of ["app.js"]) assert.ok(fs.existsSync(path.join(ROOT, path.dirname(m.entry), f)));
  }
  assert.ok(fs.existsSync(path.join(ROOT, "miniapps", "sdk.js")));
});

test("validateManifest отвергает внешний/опасный entry, лишние права, неверный id и высоту", () => {
  const ok = MA.BUILTIN[0], bad = (patch) => MA.validateManifest({ ...ok, ...patch }).ok;
  assert.equal(bad({ entry: "https://evil.example/app.html" }), false);
  assert.equal(bad({ entry: "miniapps/../index.html" }), false);
  assert.equal(bad({ entry: "miniapps/x/app.js" }), false);
  assert.equal(bad({ permissions: ["storage", "camera"] }), false);
  assert.equal(bad({ permissions: ["storage", "storage"] }), false);
  assert.equal(bad({ id: "Bad Id" }), false);
  assert.equal(bad({ height: 9999 }), false);
  assert.equal(bad({ v: 2 }), false);
  assert.equal(MA.validateManifest(null).ok, false);
});

test("мост: права проверяются, состояние хранится, лимиты и частота share", async () => {
  const env = mkEnv(), man = MA.byId("checklist");
  const s = { key: "bob|checklist", chatId: "bob", manifest: man, granted: new Set(["storage"]) };
  assert.equal(await MA.handle(s, "state.get", {}), null);
  await MA.handle(s, "state.set", { state: { items: { a: { t: "x" } } } });
  assert.deepEqual(await MA.handle(s, "state.get"), { items: { a: { t: "x" } } });
  await assert.rejects(MA.handle(s, "state.set", { state: { big: "x".repeat(17000) } }), /bad-state/);
  await assert.rejects(MA.handle(s, "state.set", { state: [1] }), /bad-state/);
  await assert.rejects(MA.handle(s, "share", { state: {} }), /permission-denied:sync/);
  await assert.rejects(MA.handle(s, "chat.post", { text: "hi" }), /permission-denied:chat.post/);
  await assert.rejects(MA.handle(s, "nope", {}), /unknown-method/);
  await assert.rejects(MA.handle(s, "constructor", {}), /unknown-method/);
  s.granted.add("sync");
  await MA.handle(s, "share", { state: { items: {} } });
  assert.equal(env.sent[0][0], "rich"); assert.equal(env.sent[0][2].kind, "miniapp"); assert.equal(env.sent[0][2].app, "checklist");
  await assert.rejects(MA.handle(s, "share", { state: {} }), /rate/);
  env.tick(1000); await MA.handle(s, "share", { state: { v: 2 } });
  await assert.rejects(MA.handle(s, "share", { state: { big: "x".repeat(9000) } }).catch((e) => { env.tick(1000); throw e; }), /bad-state/);
});

test("chat.post: каждое сообщение требует отдельного подтверждения; отказ — ничего не отправлено", async () => {
  const env = mkEnv(), s = { key: "bob|dice", chatId: "bob", manifest: MA.byId("dice"), granted: new Set(["chat.post"]) };
  env.setAnswer(false);
  await assert.rejects(MA.handle(s, "chat.post", { text: "🎲 6" }), /denied/);
  assert.equal(env.sent.length, 0);
  env.setAnswer(true);
  await MA.handle(s, "chat.post", { text: "🎲 6" }); await MA.handle(s, "chat.post", { text: "🎲 5" });
  assert.deepEqual(env.sent.map((x) => x[2]), ["🎲 6", "🎲 5"]);
  assert.equal(env.confirms().length, 3, "спрашивали при каждой попытке");
  assert.match(env.confirms()[0][0], /🎲 6/);
  await assert.rejects(MA.handle(s, "chat.post", { text: "   " }), /bad-text/);
  await MA.handle(s, "chat.post", { text: "x".repeat(900) });
  assert.equal(env.sent[2][2].length, 500);
});

test("receive: проверка приложения, права sync, размера, контейнера, блокировки и частоты; без открытого окна — в inbox и тост", () => {
  const env = mkEnv();
  const p = (o) => ({ kind: "miniapp", app: "checklist", st: { items: {} }, ...(o || {}) });
  assert.equal(MA.receive("bob", p({ app: "unknown" })), false);
  assert.equal(MA.receive("bob", p({ app: "dice" })), false, "у кубика нет права sync");
  assert.equal(MA.receive("bob", p({ st: { big: "x".repeat(9000) } })), false);
  assert.equal(MA.receive("bob", p({ st: "str" })), false);
  assert.equal(MA.receive("stranger", p()), false);
  assert.equal(MA.receive("blocked", p()), false);
  assert.equal(MA.receive("bob", null), false);
  assert.equal(MA.receive("bob", p({ st: { items: { a: { t: "один" } } } })), true);
  assert.equal(MA.receive("bob", p()), false, "слишком часто");
  env.tick(400);
  assert.equal(MA.receive("bob", p({ st: { items: { b: { t: "два" } } } })), true);
  assert.equal(env.toasts.length, 2); assert.match(env.toasts[0], /Bob/);
  const inbox = MA._takeInbox("bob|checklist");
  assert.equal(inbox.length, 1, "последнее состояние от отправителя заменяет прежнее"); assert.deepEqual(inbox[0].st.items.b, { t: "два" });
  assert.deepEqual(MA._takeInbox("bob|checklist"), []);
});

test("меню вложений: ровно один пункт, повторный вызов не дублирует, пункт стоит перед «ещё»", () => {
  const { e } = mkEnv();
  const b = MA.addMenuEntry();
  assert.ok(b); assert.equal(MA.addMenuEntry(), null); MA.addMenuEntry();
  const items = e.doc.querySelectorAll("[data-miniapp-entry]");
  assert.equal(items.length, 1);
  assert.equal(items[0].nextElementSibling.id, "composer-menu-more");
  assert.equal(items[0].querySelector("span").textContent, "Mini-apps");
  assert.equal(items[0].querySelector("svg").getAttribute("data-icon"), "code");
});

test("launch: iframe с sandbox=\"allow-scripts\" без allow-same-origin, права запрашиваются, рукопожатие и порт работают", async () => {
  const env = mkEnv();
  env.setAnswer(false);
  assert.equal(await MA.launch("bob", "checklist"), null, "отказ в правах — приложение не запускается");
  assert.equal(env.e.doc.querySelector("iframe"), null);
  assert.match(env.confirms()[0][0], /Shared checklist/); assert.match(env.confirms()[0][0], /end-to-end/);
  env.setAnswer(true);
  const s = await MA.launch("bob", "checklist");
  const fr = env.e.doc.querySelector("iframe");
  assert.equal(fr.getAttribute("sandbox"), "allow-scripts");
  assert.ok(!/allow-same-origin|allow-top-navigation|allow-popups|allow-forms|allow-modals/.test(fr.getAttribute("sandbox")));
  assert.equal(fr.getAttribute("referrerpolicy"), "no-referrer");
  assert.equal(fr.src, "https://example.test/ether/miniapps/checklist/index.html");
  assert.equal(await MA.launch("bob", "checklist"), s, "повторный запуск возвращает ту же сессию");
  // права запомнены: второй запуск после закрытия не спрашивает
  const asked = env.confirms().length;
  // рукопожатие: чужой источник игнорируется, свой — получает порт
  const got = []; Object.defineProperty(fr, "contentWindow", { value: { postMessage: (m, o, tr) => got.push([m, o, tr]) }, configurable: true });
  env.w.dispatchEvent(new env.w.MessageEvent("message", { source: env.w, data: { ether: "miniapp-hello" } }));
  assert.equal(got.length, 0, "сообщение не от iframe игнорируется");
  env.w.dispatchEvent(new env.w.MessageEvent("message", { source: fr.contentWindow, data: { ether: "miniapp-hello" } }));
  assert.equal(got.length, 1); assert.equal(got[0][0].ether, "miniapp-init"); assert.equal(got[0][1], "*"); assert.equal(got[0][2].length, 1);
  assert.deepEqual(got[0][0].perms, ["storage", "sync"]);
  const port = got[0][2][0];
  const reply = (msg) => new Promise((res) => { port.onmessage = (ev) => res(ev.data); port.postMessage(msg); });
  assert.deepEqual(await reply({ id: 1, m: "state.set", a: { state: { items: {} } } }), { t: "res", id: 1, ok: true, r: true });
  const bad = await reply({ id: 2, m: "chat.post", a: { text: "x" } });
  assert.equal(bad.ok, false); assert.match(bad.err, /permission-denied/);
  // входящее обновление при открытом окне идёт прямо в приложение
  const remote = new Promise((res) => { port.onmessage = (ev) => res(ev.data); });
  assert.equal(MA.receive("bob", { kind: "miniapp", app: "checklist", st: { items: { z: { t: "z" } } } }), true);
  assert.equal((await remote).t, "remote");
  s.sheet.querySelector(".sheet-cancel").click();
  assert.equal(MA._sessions.size, 0); assert.equal(env.e.doc.querySelector("iframe"), null);
  await MA.launch("bob", "checklist"); assert.equal(env.confirms().length, asked, "права запомнены для пары чат+приложение");
  port.close();
});

test("исходник miniapps.js не использует allow-same-origin/eval и подключён в сборку", () => {
  const src = fs.readFileSync(path.join(ROOT, "js", "miniapps.js"), "utf8");
  assert.ok(!/allow-same-origin['"]/.test(src.replace(/\/\/[^\n]*/g, "")), "allow-same-origin нельзя включать");
  assert.ok(!/\beval\(|new Function\(|innerHTML\s*=/.test(src));
  assert.ok(fs.readFileSync(path.join(ROOT, "tools", "build-bundles.js"), "utf8").includes("js/miniapps.js"));
  assert.ok(fs.readFileSync(path.join(ROOT, "js", "bundle.features.js"), "utf8").includes("EtherMiniApps"));
});
