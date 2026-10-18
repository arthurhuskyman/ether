// Поиск по хэшу телефона/почты: нормализация и HMAC, UI скрыт без feature, добавление найденного контакта, лимиты, XSS в имени, публикация по умолчанию выключена.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { closeAll } = require("./harness");
const { boot, sleep } = require("./cov-helpers");
test.after(closeAll);

const SALT = "s".repeat(32);
const hm = (s) => crypto.createHmac("sha256", SALT).update(s).digest("hex");
const idOf = (n) => crypto.createHash("sha256").update("ether:" + n).digest("hex");

function setup(a, features) {
  a.run(`(() => { Store.myId = ${JSON.stringify(idOf("+79990001122"))}; Store.myIdentityRaw = "+79990001122"; Store.name = "Me"; state._firstRenderDone = true;
    const s = new EventTarget(); s.connected = true; s.registered = true; s.features = ${JSON.stringify(features)}; s.discoverySalt = ${JSON.stringify(features.includes("discovery") ? SALT : "")}; s.discoveryPublished = false;
    s.sent = []; s.stop = () => {}; s.start = () => {}; s.watch = () => {}; s.signal = () => true; s.mailboxAck = () => {}; s.sendPushSubscription = () => {};
    s.discoveryPublish = (h, sn, n) => { s.sent.push(["pub", h, sn, n]); s.discoveryPublished = h.length > 0; return true; };
    s.discoveryLookup = (rid, hashes) => { s.sent.push(["lookup", hashes]); const r = window.__reply ? window.__reply(hashes) : { found: [] }; setTimeout(() => s.dispatchEvent(new CustomEvent("discovery-result", { detail: Object.assign({ rid, found: [], error: null }, r) })), 0); return true; };
    signaling = s; window.__sig = s; window.__cleanup = wireSignalingEvents(s); wireDiscoveryUI();
    s.dispatchEvent(new CustomEvent("discovery-state", { detail: { salt: s.discoverySalt, published: false } })); })()`);
}
const hidden = (a, sel) => a.document.querySelector(sel).classList.contains("hidden");

test("нормализация и HMAC совпадают с эталоном, невалидное отбрасывается", async () => {
  const a = await boot();
  const r = await a.run(`Discovery.prepare(["+7 (999) 000-11-22", "79990001122", "  Foo@Bar.COM ", "foo@bar.com", "abc", "123", ""], ${JSON.stringify(SALT)}).then((x) => JSON.parse(JSON.stringify(x)))`);
  assert.equal(r.length, 2, "дубликаты схлопнуты, мусор отброшен");
  assert.equal(r[0].normalized, "+79990001122"); assert.equal(r[0].hash, hm("+79990001122")); assert.equal(r[0].id, idOf("+79990001122"));
  assert.equal(r[1].normalized, "foo@bar.com"); assert.equal(r[1].hash, hm("foo@bar.com"));
  assert.deepEqual(Array.from(await a.run(`Discovery.splitInput("a@b.co, +1 555 0100;\\n\\n x")`)), ["a@b.co", "+1 555 0100", "x"]);
  a.close();
});

test("UI скрыт без feature discovery и показан с ним", async () => {
  const a = await boot(); setup(a, ["ratchet2", "claim"]);
  assert.ok(hidden(a, "#settings-discovery-block")); assert.ok(hidden(a, "#find-by-phone-btn"));
  const b = await boot(); setup(b, ["ratchet2", "discovery"]);
  assert.ok(!hidden(b, "#settings-discovery-block")); assert.ok(!hidden(b, "#find-by-phone-btn"));
  assert.equal(b.run(`Store.phoneDiscover`), false, "по умолчанию выключено");
  assert.equal(b.document.querySelector("#settings-discovery").checked, false);
  assert.deepEqual(b.run(`__sig.sent.filter((x) => x[0] === "pub").length`), 0, "ничего не публикуется без согласия");
  a.close(); b.close();
});

test("включение: подтверждение, публикация хэша без имени; выключение снимает запись", async () => {
  const a = await boot(); setup(a, ["discovery"]);
  a.run(`window.confirmSheet = async () => false;`);
  const cb = a.document.querySelector("#settings-discovery");
  cb.checked = true; cb.dispatchEvent(new a.window.Event("change")); await sleep(30);
  assert.equal(a.run(`Store.phoneDiscover`), false, "отказ в подтверждении = не включено"); assert.equal(cb.checked, false);
  a.run(`window.confirmSheet = async () => true;`);
  cb.checked = true; cb.dispatchEvent(new a.window.Event("change")); await sleep(60);
  assert.equal(a.run(`Store.phoneDiscover`), true);
  const pub = JSON.parse(JSON.stringify(a.run(`__sig.sent.filter((x) => x[0] === "pub")`)));
  assert.equal(pub.length, 1); assert.deepEqual(pub[0][1], [hm("+79990001122")]); assert.equal(pub[0][2], false); assert.equal(pub[0][3], "", "имя не уходит без разрешения");
  cb.checked = false; cb.dispatchEvent(new a.window.Event("change")); await sleep(30);
  const pub2 = JSON.parse(JSON.stringify(a.run(`__sig.sent.filter((x) => x[0] === "pub")`)));
  assert.deepEqual(pub2[pub2.length - 1][1], [], "выключение = снятие записи");
  a.close();
});

test("нет телефона/почты в профиле — включить нельзя", async () => {
  const a = await boot(); setup(a, ["discovery"]);
  a.run(`Store.myIdentityRaw = "";`);
  const cb = a.document.querySelector("#settings-discovery"); cb.checked = true; cb.dispatchEvent(new a.window.Event("change")); await sleep(30);
  assert.equal(a.run(`Store.phoneDiscover`), false);
  a.close();
});

test("поиск: найденный контакт добавляется, чужой id и XSS в имени обезврежены, свой номер не ищется", async () => {
  const a = await boot(); setup(a, ["discovery"]);
  const pk = { kty: "EC", crv: "P-256", x: "AAAA", y: "BBBB" };
  a.window.__reply = (hashes) => ({ found: [
    { hash: hm("+15551230001"), id: idOf("+15551230001"), publicKey: pk, name: '<img src=x onerror="window.__xss=1">Боб' },
    { hash: hm("+15551230002"), id: "f".repeat(64), publicKey: pk }, // сервер подсунул чужой id под известный хэш
    { hash: hm("+15559999999"), id: idOf("+15559999999"), publicKey: pk }, // хэш, которого не спрашивали
  ] });
  a.document.querySelector("#discovery-input").value = "+1 555 123 0001\n+1 555 123 0002\n+7 999 000 11 22";
  a.document.querySelector("#find-by-phone-btn").click();
  assert.ok(!a.document.querySelector("#discovery-sheet").classList.contains("hidden"));
  a.document.querySelector("#discovery-search-btn").click(); await sleep(150);
  const asked = JSON.parse(JSON.stringify(a.run(`__sig.sent.filter((x) => x[0] === "lookup")`)));
  assert.equal(asked.length, 1); assert.deepEqual(asked[0][1].sort(), [hm("+15551230001"), hm("+15551230002")].sort(), "свой номер не отправляется, телефоны — только хэшами");
  const rows = a.document.querySelectorAll("#discovery-results .forward-row");
  assert.equal(rows.length, 1, "только прошедшие проверку id");
  assert.equal(a.document.querySelector("#discovery-results img"), null, "HTML в имени не разобран");
  assert.ok(rows[0].textContent.includes("<img"), "имя показано как текст");
  assert.equal(a.window.__xss, undefined);
  rows[0].querySelector("button").click(); await sleep(30);
  const c = a.run(`(() => { const c = state.contacts.get(${JSON.stringify(idOf("+15551230001"))}); return c && { pk: !!c.publicKey, raw: c.raw, managed: c.managed }; })()`);
  assert.deepEqual(JSON.parse(JSON.stringify(c)), { pk: true, raw: "+15551230001", managed: true });
  assert.ok(!a.run(`state.contacts.has("f".repeat(64))`));
  a.close();
});

test("лимит сервера: сообщение об ограничении, пустой результат, без сети ничего не уходит", async () => {
  const a = await boot(); setup(a, ["discovery"]);
  a.window.__reply = () => ({ found: [], error: "rate" });
  a.document.querySelector("#discovery-input").value = "friend@example.com";
  a.document.querySelector("#discovery-search-btn").click(); await sleep(100);
  assert.equal(a.document.querySelector("#discovery-status").textContent, a.run(`T("discovery.rate")`));
  a.run(`__sig.connected = false;`); a.run(`__sig.sent.length = 0`);
  a.document.querySelector("#discovery-search-btn").click(); await sleep(60);
  assert.equal(a.run(`__sig.sent.length`), 0);
  // >200 хэшей режутся на пачки по 200
  const sig = a.run(`__sig`); a.run(`__sig.connected = true; __sig.sent.length = 0; window.__reply = () => ({ found: [] });`);
  a.document.querySelector("#discovery-input").value = Array.from({ length: 450 }, (_, i) => "+1555" + String(1000000 + i)).join("\n");
  a.document.querySelector("#discovery-search-btn").click(); await sleep(400);
  assert.deepEqual(JSON.parse(JSON.stringify(a.run(`__sig.sent.filter((x) => x[0] === "lookup").map((x) => x[1].length)`))), [200, 200, 50]);
  a.close();
});
