// Закрытие хвостов аудита: claim-токен id (клиент), caps env2, LWW-часы, автообновление SW
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closeAll } = require("./harness");
test.after(closeAll);

async function booted(id, name, storage) {
  const a = createApp({ storage: Object.assign({ "ether.name": name, "ether.myId": id, "ether.lang": "en" }, storage || {}) });
  await a.ready;
  for (let i = 0; i < 60 && !a.run(`typeof __appStarted !== "undefined" && __appStarted && !!Store.myPublicKeyJwk`); i++) await new Promise((r) => setTimeout(r, 50));
  return a;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const FAKE_WS = `window.__fws = []; window.WebSocket = class { static get CONNECTING() { return 0; } static get OPEN() { return 1; }
  constructor(u) { this.readyState = 1; this.sent = []; this.l = {}; window.__fws.push(this); }
  send(d) { this.sent.push(JSON.parse(d)); } close() { this.readyState = 3; }
  addEventListener(t, f) { (this.l[t] = this.l[t] || []).push(f); }
  emit(t, ev) { (this.l[t] || []).forEach((f) => f(ev || {})); } };`;

test("claim-токен: создаётся один раз, лежит в резервной копии, по сети уходит только sha256-доказательство", async () => {
  const a = await booted("claim-a", "A");
  const t1 = a.run(`Store.claimToken`), t2 = a.run(`Store.claimToken`);
  assert.match(t1, /^[0-9a-f]{64}$/); assert.equal(t1, t2, "токен стабилен");
  assert.equal(a.run(`CRITICAL_LS_KEYS.includes("ether.claimToken")`), true, "в резервной копии IDB");
  assert.equal(a.run(`SecureStore.KEYS.includes("ether.claimToken")`), true, "шифруется вместе с остальными секретами");
  a.window.__p = undefined;
  a.run(`claimProof().then((p) => { window.__p = p; })`);
  for (let i = 0; i < 40 && !a.window.__p; i++) await wait(25);
  const crypto = require("crypto");
  assert.equal(a.window.__p, crypto.createHash("sha256").update("ether-claim-v1|" + t1).digest("hex"));
  assert.notEqual(a.window.__p, t1);
  // register: claim — доказательство, самого токена в сообщении нет
  a.run(FAKE_WS);
  a.run(`window.__sc = new SignalingClient("ws://x", "claim-a", {}); window.__sc.claim = ${JSON.stringify(a.window.__p)}; window.__sc.start();`);
  const ws = a.window.__fws[0]; ws.emit("open");
  const reg = ws.sent.find((m) => m.type === "register");
  assert.equal(reg.claim, a.window.__p);
  assert.deepEqual(JSON.parse(JSON.stringify(reg.caps)), ["env2"]);
  assert.ok(!JSON.stringify(reg).includes(t1), "секрет не уходит по сети");
  a.close();
});

test("claim-токен: переезжает с резервной копией (тот же токен после восстановления), id-claimed останавливает переподключение и показывает тост", async () => {
  const tok = "ab".repeat(32);
  const a = await booted("claim-b", "B", { "ether.claimToken": tok });
  assert.equal(a.run(`Store.claimToken`), tok, "восстановленный токен не перегенерируется");
  a.run(FAKE_WS);
  a.run(`window.__sc = new SignalingClient("ws://x", "claim-b", {}); window.__ev = []; window.__sc.addEventListener("register-error", (e) => window.__ev.push(e.detail.error)); window.__sc.start();`);
  const ws = a.window.__fws[0]; ws.emit("open");
  ws.emit("message", { data: JSON.stringify({ type: "register-error", error: "id-claimed", id: "claim-b" }) });
  assert.deepEqual(JSON.parse(JSON.stringify(a.window.__ev)), ["id-claimed"]);
  assert.equal(a.run(`window.__sc.shouldRun`), false, "после id-claimed клиент не долбит сервер");
  a.close();
});

test("claim-токен: сообщение об отказе привязано к i18n и показывается в тосте", async () => {
  const a = await booted("claim-c", "C");
  a.run(`signaling && signaling.dispatchEvent(new CustomEvent("register-error", { detail: { error: "id-claimed" } }))`);
  await wait(50);
  const txt = a.run(`T("toast.idClaimed")`);
  assert.ok(txt && txt !== "toast.idClaimed");
  assert.match(a.document.body.textContent, new RegExp(txt.slice(0, 20).replace(/[()]/g, "")));
  a.close();
});

test("caps env2: присутствие/ростер/ping помечают контакт, c.e2 сохраняется в контактах", async () => {
  const a = await booted("caps-a", "A");
  a.run(`ensureContactEntry("p-1", "P1"); ensureContactEntry("p-2", "P2"); ensureContactEntry("p-3", "P3");`);
  a.run(`signaling.dispatchEvent(new CustomEvent("presence", { detail: { id: "p-1", online: true, name: "P1", visible: true, publicKey: null, caps: ["env2"] } }))`);
  a.run(`signaling.dispatchEvent(new CustomEvent("online-list", { detail: { users: [{ id: "p-2", name: "P2", visible: true, publicKey: null, caps: ["env2"] }] } }))`);
  assert.equal(a.run(`!!state.contacts.get("p-1").e2`), true);
  assert.equal(a.run(`!!state.contacts.get("p-2").e2`), true);
  assert.equal(a.run(`!!state.contacts.get("p-3").e2`), false, "без объявления поддержки остаётся v1");
  a.run(`persistContactsNow()`);
  assert.match(a.run(`localStorage.getItem("ether.contacts")`), /"e2":true/);
  a.close();
});

test("LWW-часы: время отправителя, но не позже «получение + допуск»; мусор и древность → время получения", async () => {
  const a = await booted("lww-a", "A");
  const now = 1_700_000_000_000;
  assert.equal(a.run(`clampOpTs(${now - 5000}, ${now})`), now - 5000, "честное прошлое сохраняется (офлайн-доставка)");
  assert.equal(a.run(`clampOpTs(${now + 3600e3}, ${now})`), now + 30000, "время «из будущего» ограничено допуском");
  assert.equal(a.run(`clampOpTs("абв", ${now})`), now);
  assert.equal(a.run(`clampOpTs(1, ${now})`), now, "ts:1 не должен ломать порядок");
  assert.equal(a.run(`clampOpTs(-5, ${now})`), now);
  assert.equal(a.run(`clampOpTs(${now - 20 * 86400e3}, ${now})`), now, "старше срока хранения ящика → время получения");
  a.close();
});

test("SW: автоприменение обновления только когда приложение скрыто, нет звонка и нет черновика, и после паузы", async () => {
  const a = await booted("sw-a", "A");
  const f = (o) => a.run(`shouldAutoApplyUpdate(${JSON.stringify(o)})`);
  const base = { waitingSince: 1000, now: 1000 + 11 * 60000, hidden: true, inCall: false, hasDraft: false };
  assert.equal(f(base), true);
  assert.equal(f({ ...base, now: 1000 + 5 * 60000 }), false, "рано");
  assert.equal(f({ ...base, hidden: false }), false, "пока пользователь смотрит — не трогаем");
  assert.equal(f({ ...base, inCall: true }), false);
  assert.equal(f({ ...base, hasDraft: true }), false);
  assert.equal(f({ ...base, waitingSince: 0 }), false);
  a.close();
});

test("SW отвечает на GET_VERSION версией оболочки", async () => {
  const fs = require("fs"), path = require("path"), vm = require("vm");
  const src = fs.readFileSync(path.join(__dirname, "..", "sw.js"), "utf8");
  const listeners = {}; const posted = [];
  const ctx = { self: { addEventListener: (t, f) => { listeners[t] = f; }, skipWaiting() {}, clients: { claim() {}, matchAll: async () => [] }, registration: {} }, caches: {}, location: { origin: "http://x" }, URL, Response, fetch: async () => ({}) };
  vm.createContext(ctx); vm.runInContext(src, ctx);
  listeners.message({ data: { type: "GET_VERSION" }, source: { postMessage: (m) => posted.push(m) }, waitUntil() {} });
  assert.equal(posted[0].type, "sw-version"); assert.match(posted[0].version, /^ether-shell-v\d+$/);
});
