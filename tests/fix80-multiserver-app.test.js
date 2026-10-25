// multi-server resilience на клиенте: config.js + список, автофейловер с подменёнными сокетами/таймерами, подсказки srv (ссылка, QR, карточка, ростер), шторка «Серверы».
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("fs"), path = require("path");
const { closeAll } = require("./harness");
const { boot, sleep, fakeWebSocket, fakeTimers } = require("./cov-helpers");
test.after(closeAll);

const DEF = "wss://ether-1-baqy.onrender.com";
const A = "wss://a.example.com", B = "wss://b.example.com", C = "wss://c.example.com";
const sv = (...u) => JSON.stringify(u.map((url) => ({ url, label: url.slice(6), addedAt: 1 })));
const J = (a, code) => JSON.parse(a.run(`JSON.stringify(${code})`));

test("config.js: подключён в index.html до бандлов, лежит в кэше SW и в списке сборки; встроенный сервер = прежний", () => {
  const root = path.join(__dirname, ".."), html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const i = html.indexOf('<script src="config.js"></script>');
  assert.ok(i > 0 && i < html.indexOf('src="js/bundle.core.js"'));
  assert.ok(fs.readFileSync(path.join(root, "sw.js"), "utf8").includes('"./config.js"'));
  const cfg = fs.readFileSync(path.join(root, "config.js"), "utf8");
  assert.ok(cfg.includes(DEF) && cfg.includes("mirrors"));
  assert.ok(/serverlist\.js/.test(fs.readFileSync(path.join(root, "tools/build-bundles.js"), "utf8")));
});

test("список: один встроенный сервер как раньше; свои серверы впереди; поле «Сервер» (legacy) заменяет встроенные и не даёт им подменять путь", async () => {
  const a = await boot();
  assert.deepEqual(J(a, `serverEntries().map((e) => e.url)`), [DEF]);
  assert.equal(a.run(`effectiveSignalingUrl()`), DEF);
  assert.equal(a.run(`signalingHttpBase()`), "https://ether-1-baqy.onrender.com");
  assert.equal(a.run(`signalingUrlForIce()`), "https://ether-1-baqy.onrender.com");
  const b = await boot({ storage: { "ether.servers": sv(A, B) } });
  assert.deepEqual(J(b, `serverEntries().map((e) => e.url)`), [A, B, DEF]);
  assert.equal(b.run(`effectiveSignalingUrl()`), A);
  const c = await boot({ storage: { "ether.signalingUrl": "ws://10.0.0.5:8787", "ether.servers": sv(B) } });
  assert.deepEqual(J(c, `serverEntries().map((e) => e.url)`), ["ws://10.0.0.5:8787", B], "встроенный сервер не добавляется при своём сервере");
  assert.equal(c.run(`effectiveSignalingUrl()`), "ws://10.0.0.5:8787");
  assert.equal(c.run(`signalingHttpBase()`), "http://10.0.0.5:8787");
  const d = await boot({ storage: { "ether.servers": sv(A), "ether.serversOff": JSON.stringify([DEF]) } });
  assert.deepEqual(J(d, `serverEntries().map((e) => e.url)`), [A]);
});

test("фейловер: 3 неудачных подключения -> новый клиент на следующем сервере, HTTP-база и /ice следуют за активным, на новом сервере — заметка про первую регистрацию", async () => {
  const a = await boot({ storage: { "ether.servers": sv(A, B), "ether.serversSeen": JSON.stringify([A]) } });
  fakeWebSocket(a); const fk = fakeTimers(a);
  a.run(`window.__sw = []; swRegistration = { active: { postMessage: (m) => window.__sw.push(m) } }; initSignaling()`); await sleep(30);
  const last = () => a.run(`__sockets[__sockets.length - 1].url`);
  assert.equal(last(), A);
  for (let i = 0; i < 3; i++) {
    a.run(`__sockets[__sockets.length - 1].__err()`); // ошибка до open = неудачная попытка
    fk.tick(3000); // пауза повтора 1.0 / 1.6 / 2.6 с; таймаут подключения (7 с) на новом сервере ещё не наступает
  }
  fk.tick(50);
  assert.equal(last(), B, "переключились на второй сервер");
  assert.equal(a.run(`effectiveSignalingUrl()`), B);
  assert.equal(a.run(`signalingHttpBase()`), "https://b.example.com");
  assert.equal(a.run(`signalingUrlForIce()`), "https://b.example.com");
  assert.deepEqual(J(a, `window.__sw.map((m) => m.httpBase)`), ["https://a.example.com", "https://b.example.com"], "service worker получил адрес нового сервера (ring-config)");
  assert.equal(a.run(`localStorage.getItem("ether.serverLastGood")`), null, "последний рабочий пишется по успешной регистрации");
  a.run(`(() => { const s = __sockets[__sockets.length - 1]; s.__open(); s.__recv({ type: "registered", id: "me-test-id", online: [], features: ["claim"] }); })()`);
  assert.equal(a.run(`localStorage.getItem("ether.serverLastGood")`), B);
  assert.match(a.run(`document.getElementById("toast").textContent`), /new server/i);
  assert.deepEqual(JSON.parse(a.run(`localStorage.getItem("ether.serversSeen")`)), [A, B]);
  assert.ok(a.run(`signaling.registered === true`));
});

test("фейловер: единственный сервер не переключается и после сбоев остаётся на нём; id-claimed на запасном -> следующий", async () => {
  const a = await boot();
  fakeWebSocket(a); const fk = fakeTimers(a);
  a.run(`initSignaling()`); await sleep(30);
  for (let i = 0; i < 5; i++) { a.run(`__sockets[__sockets.length - 1].__err()`); fk.tick(25000); }
  assert.equal(a.run(`__sockets[__sockets.length - 1].url`), DEF);
  assert.equal(a.run(`state._serversDown`), true, "показываем состояние «нет сервера»");
  assert.match(a.run(`document.getElementById("nav-conn-indicator").textContent`), /No server reachable/);
  const b = await boot({ storage: { "ether.servers": sv(A, B) } });
  fakeWebSocket(b); const fk2 = fakeTimers(b);
  b.run(`initSignaling()`); await sleep(30);
  b.run(`(() => { const s = __sockets[__sockets.length - 1]; s.__open(); s.__recv({ type: "register-error", error: "id-claimed", claimTtlH: 1 }); })()`);
  fk2.tick(100);
  assert.equal(b.run(`effectiveSignalingUrl()`), B, "id занят на этом сервере: пробуем следующий");
});

test("подсказки srv: ссылка-приглашение, QR, разбор, обратная совместимость со старым разбором, выключатель", async () => {
  const a = await boot({ storage: { "ether.servers": sv(A, B), "ether.name": "Ann" } });
  const link = a.run(`myAddLink()`);
  const hash = new URL(link).hash;
  assert.match(hash, /^#add=me-test-id&name=Ann&srv=/);
  const srv = decodeURIComponent(hash.match(/&srv=([^&]*)/)[1]);
  assert.equal(srv, "https://a.example.com,https://b.example.com,https://ether-1-baqy.onrender.com");
  // старый клиент: разбирает add и name регулярками, лишний параметр не мешает
  assert.equal(decodeURIComponent(hash.match(/(?:^#|&)add=([^&]+)/)[1]), "me-test-id"); assert.equal(decodeURIComponent(hash.match(/&name=([^&]*)/)[1]), "Ann");
  // QR
  a.run(`window.__qr = ""; window.qrcode = () => ({ addData(p) { window.__qr = p; }, make() {}, getModuleCount: () => 1, isDark: () => false }); renderQrToCanvas(document.createElement("canvas"))`);
  const qr = a.run(`window.__qr`);
  assert.match(qr, /^ether:\/\/add\?id=me-test-id&name=Ann&srv=/);
  const p = a.run(`parseQrAddPayload(window.__qr)`);
  assert.equal(p.id, "me-test-id"); assert.deepEqual(J(a, `(window.__p = parseQrAddPayload(window.__qr), window.__p.servers)`), [A, B, DEF]);
  assert.deepEqual(J(a, `JSON.parse(JSON.stringify(parseQrAddPayload("ether://add?id=x&name=Y")))`), { id: "x", name: "Y" }, "без srv — прежняя форма");
  assert.deepEqual(J(a, `JSON.parse(JSON.stringify(parseQrAddPayload("ether://add?id=x&srv=" + encodeURIComponent("http://evil.example.com,javascript:1,https://ok.example.com"))))`), { id: "x", name: "", servers: ["wss://ok.example.com"] }, "только https/wss");
  // выключатель и единственный встроенный сервер: ничего не рекламируем
  a.run(`localStorage.setItem("ether.srvShare", "0")`); assert.doesNotMatch(a.run(`myAddLink()`), /srv=/);
  const d = await boot(); assert.doesNotMatch(d.run(`myAddLink()`), /srv=/);
});

test("контакт хранит servers[]: добавление из ссылки/карточки, сохранение и загрузка, не больше 3, чужие ссылки не перезаписывают известное", async () => {
  const a = await boot();
  a.run(`addContactFromCard("peer-1", "Pat", ["wss://p1.example.com", "wss://p2.example.com", "wss://p3.example.com", "wss://p4.example.com"])`);
  assert.deepEqual(J(a, `state.contacts.get("peer-1").servers`), ["wss://p1.example.com", "wss://p2.example.com", "wss://p3.example.com"]);
  const saved = JSON.parse(a.run(`(persistContactsNow(), Store.contactsJson)`));
  assert.deepEqual(saved.find((c) => c.id === "peer-1").servers, ["wss://p1.example.com", "wss://p2.example.com", "wss://p3.example.com"]);
  a.run(`state.contacts.clear(); loadContacts()`);
  assert.deepEqual(J(a, `state.contacts.get("peer-1").servers`), ["wss://p1.example.com", "wss://p2.example.com", "wss://p3.example.com"]);
  a.run(`addContactFromCard("peer-2", "Quinn")`);
  assert.equal(a.run(`state.contacts.get("peer-2").servers`), undefined, "без подсказок поле не появляется");
  // карточка контакта: srv едет в payload и в кнопку «Добавить»
  a.run(`applyIncomingPayload("peer-1", "env-1", { kind: "contact-card", id: "cc1", ts: Date.now(), contactId: "third", contactName: "Third", srv: "https://t1.example.com,http://evil.example.com" }, false)`);
  const card = J(a, `state.contacts.get("peer-1").messages.find((m) => m.id === "cc1").contactCard`);
  assert.deepEqual(card, { id: "third", name: "Third", servers: ["wss://t1.example.com"] });
  assert.match(a.run(`contactCardBubbleHtml(${JSON.stringify(card)})`), /data-add-contact-srv="https:\/\/t1\.example\.com"/);
  // приглашение в группу: srv у реферера
  const code = a.run(`(() => { state.contacts.set("g1", { id: "g1", isGroup: true, name: "G", managed: true, members: [{ id: Store.myId, name: "T", role: "admin" }], messages: [] }); localStorage.setItem("ether.servers", ${JSON.stringify(sv(A))}); return buildGroupInviteCode("g1"); })()`);
  assert.match(code, /&srv=/);
  assert.deepEqual(J(a, `parseGroupInviteCode(${JSON.stringify(code)}).servers`), [DEF, A]);
});

test("ростер группы: своя запись несёт srv, чужие записи нет; получатель учит серверы отправителя и не хранит srv в составе группы", async () => {
  const a = await boot({ storage: { "ether.servers": sv(A) } });
  const sent = [];
  a.window.__sent = sent;
  a.run(`trySendOrQueue = async (c, id, p) => { window.__sent.push(JSON.parse(JSON.stringify(p))); }`);
  a.run(`(() => { const g = { id: "g2", isGroup: true, name: "G2", managed: true, createdBy: Store.myId, members: [{ id: Store.myId, name: "T", role: "admin" }, { id: "bob", name: "Bob", role: "member" }], messages: [] }; state.contacts.set("g2", g); ensureContactEntry("bob", "Bob"); sendGroupRosterTo(g, "bob"); })()`);
  await sleep(100);
  const inv = sent.find((p) => p.kind === "group-invite");
  assert.ok(inv, "ростер отправлен");
  assert.equal(inv.members.find((m) => m.id === "me-test-id").srv, "https://a.example.com,https://ether-1-baqy.onrender.com");
  assert.equal(inv.members.find((m) => m.id === "bob").srv, undefined);
  assert.equal(a.run(`state.contacts.get("g2").members.some((m) => "srv" in m)`), false, "локальный состав группы не меняется");
  // получатель
  const b = await boot();
  b.run(`ensureContactEntry("admin1", "Adm")`);
  b.run(`applyIncomingPayload("admin1", "env-r", ${JSON.stringify(Object.assign({}, inv, { id: "inv-1", members: [{ id: "admin1", name: "Adm", role: "admin", srv: "https://x.example.com" }, { id: "me-test-id", name: "Tester", role: "member", srv: "https://evil.example.com" }] }))}, false)`);
  assert.deepEqual(J(b, `state.contacts.get("admin1").servers`), ["wss://x.example.com"]);
  assert.equal(b.run(`state.contacts.get("me-test-id")`), undefined);
  assert.equal(b.run(`(state.contacts.get(${JSON.stringify(inv.groupId)}) || { members: [] }).members.some((m) => "srv" in m)`), false);
});

test("доставка через серверы получателя: цели исключают активный, flushOutbox работает без подключения к активному", async () => {
  const a = await boot({ storage: { "ether.servers": sv(A) } });
  a.run(`ensureContactEntry("bob", "Bob"); state.contacts.get("bob").servers = ["wss://a.example.com", "wss://b.example.com", "wss://c.example.com"]; state.contacts.get("bob").publicKey = {};`);
  assert.deepEqual(J(a, `srvRemoteTargets(state.contacts.get("bob"))`), [B, C], "активный A исключён");
  assert.deepEqual(J(a, `srvRemoteTargets(ensureContactEntry("zed", "Zed"))`), []);
  assert.equal(a.run(`srvOutboxHasRemote()`), false);
  a.run(`outbox.set("m1", { msgId: "m1", to: "bob", payload: { kind: "chat", id: "m1", text: "x" }, sentAt: Date.now(), attempts: 0 })`);
  assert.equal(a.run(`srvOutboxHasRemote()`), true);
});

test("шторка «Серверы»: открытие, статусы и RTT, добавление с проверкой, приоритет, удаление, строки aria", async () => {
  const fetchLog = [];
  const a = await boot({ fetch: async (url) => { fetchLog.push(String(url)); if (/a\.example/.test(url)) return { ok: true, json: async () => ({ version: "1.1.0", features: [] }) }; throw new Error("down"); }, storage: { "ether.servers": sv(A) } });
  const $ = (s) => a.document.querySelector(s);
  $("#servers-open-btn").click();
  assert.equal($("#servers-sheet").classList.contains("hidden"), false);
  assert.ok($("#servers-open-btn").closest("[data-settings-adv]"), "кнопка в блоке «Дополнительно»");
  await sleep(300);
  const rows = () => Array.from(a.document.querySelectorAll("#servers-list .server-row"));
  assert.equal(rows().length, 2);
  assert.match(rows()[0].textContent, /a\.example\.com/); assert.match(rows()[0].textContent, /\d+ ms/);
  assert.ok(rows()[0].querySelector(".status-dot.online")); assert.ok(rows()[1].querySelector(".status-dot.off"));
  assert.ok(fetchLog.some((u) => u === "https://a.example.com/info"));
  for (const btn of $("#servers-sheet").querySelectorAll("[data-srv-act]")) assert.ok(btn.getAttribute("aria-label"));
  assert.ok(rows()[0].querySelector(".status-dot").getAttribute("aria-label"));
  // добавление
  $("#servers-add-input").value = "not a url"; $("#servers-add-btn").click();
  assert.match($("#toast").textContent, /not a valid server address/i); assert.equal(rows().length, 2);
  $("#servers-add-input").value = "wss://b.example.com"; $("#servers-add-btn").click(); await sleep(50);
  assert.equal(rows().length, 3);
  $("#servers-add-input").value = "WSS://B.example.com/"; $("#servers-add-btn").click();
  assert.match($("#toast").textContent, /already in the list/i);
  // приоритет: сделать основным встроенный сервер
  rows()[2].querySelector('[data-srv-act="primary"]').click();
  assert.deepEqual(J(a, `serverEntries().map((e) => e.url)`), [DEF, A, B]);
  assert.equal(a.run(`effectiveSignalingUrl()`), DEF);
  // удаление встроенного: в «выключенных»; последний не удаляется
  const defRow = rows().find((r) => r.getAttribute("data-url") === DEF);
  defRow.querySelector('[data-srv-act="remove"]').click();
  assert.deepEqual(J(a, `serverEntries().map((e) => e.url)`), [A, B]);
  assert.deepEqual(JSON.parse(a.run(`localStorage.getItem("ether.serversOff")`)), [DEF]);
  assert.equal(a.run(`effectiveSignalingUrl()`), A, "удалили активный — перешли на следующий");
  rows()[1].querySelector('[data-srv-act="remove"]').click();
  assert.equal(rows().length, 1); assert.equal(rows()[0].querySelector('[data-srv-act="remove"]'), null, "последний сервер без кнопки удаления");
  // выключатель srv
  $("#servers-share").checked = false; $("#servers-share").dispatchEvent(new a.window.Event("change"));
  assert.equal(a.run(`localStorage.getItem("ether.srvShare")`), "0");
});

test("импорт подписанного списка: без ключа — только показ (ничего не применяется само), с ключом — проверка подписи и применение", async () => {
  const a = await boot();
  const $ = (s) => a.document.querySelector(s);
  const subtle = crypto.webcrypto.subtle;
  const kp = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const L = { v: 1, ts: 100, servers: [{ url: "wss://s1.example.com", label: "S1" }, { url: "wss://s2.example.com", label: "S2" }] };
  const SL = require("../js/serverlist.js");
  const sig = Buffer.from(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, new TextEncoder().encode(SL.canonical(SL.parseSigned(Object.assign({}, L, { sig: "x" })))))).toString("base64url");
  const signed = Object.assign({}, L, { sig });
  $("#servers-open-btn").click();
  assert.equal(a.run(`window.RELEASE_PUBKEY`), null);
  await a.run(`srvImportText(${JSON.stringify(JSON.stringify(signed))})`);
  assert.match($("#servers-import-out").textContent, /could not be checked/i);
  assert.equal($("#servers-import-out").querySelector(".btn-secondary"), null, "кнопки «применить» нет");
  assert.equal(a.run(`localStorage.getItem("ether.serversSigned")`), null);
  assert.deepEqual(J(a, `serverEntries().map((e) => e.url)`), [DEF]);
  await a.run(`srvRefreshSigned(undefined, { obj: ${JSON.stringify(signed)} })`);
  assert.equal(a.run(`localStorage.getItem("ether.serversSigned")`), null, "автоприменение без ключа запрещено");
  // ручное добавление одного сервера из показанного списка
  $("#servers-import-out [data-srv-import-add]").click();
  assert.ok(a.run(`serverEntries().some((e) => e.url === "wss://s1.example.com")`));
  // ключ есть
  a.window.RELEASE_PUBKEY = await subtle.exportKey("jwk", kp.publicKey);
  await a.run(`srvImportText(${JSON.stringify(JSON.stringify(signed))})`);
  assert.match($("#servers-import-out").textContent, /Signature is valid/);
  const apply = $("#servers-import-out .btn-secondary"); assert.ok(apply); apply.click();
  assert.equal(JSON.parse(a.run(`localStorage.getItem("ether.serversSigned")`)).ts, 100);
  const bad = JSON.parse(JSON.stringify(signed)); bad.servers[0].url = "wss://evil.example.com";
  await a.run(`srvImportText(${JSON.stringify(JSON.stringify(bad))})`);
  assert.match($("#servers-import-out").textContent, /do not trust/i); assert.equal($("#servers-import-out .btn-secondary"), null);
  await a.run(`srvImportText("not json")`); assert.match($("#servers-import-out").textContent, /not a server list/i);
  // автоподхват servers.json с верной подписью; откат на более старую версию игнорируется
  const newer = Object.assign({}, L, { ts: 300 }); newer.sig = Buffer.from(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, new TextEncoder().encode(SL.canonical(SL.parseSigned(Object.assign({}, newer, { sig: "x" })))))).toString("base64url");
  await a.run(`srvRefreshSigned(undefined, { obj: ${JSON.stringify(newer)} })`);
  assert.equal(JSON.parse(a.run(`localStorage.getItem("ether.serversSigned")`)).ts, 300);
  await a.run(`srvRefreshSigned(undefined, { obj: ${JSON.stringify(signed)} })`);
  assert.equal(JSON.parse(a.run(`localStorage.getItem("ether.serversSigned")`)).ts, 300, "старая подписанная версия не откатывает список");
});

test("нет серверов: состояние в шторке и «Режим без сервера (код/QR)» открывает ручное подключение", async () => {
  const a = await boot();
  const $ = (s) => a.document.querySelector(s);
  a.run(`state._serversDown = true; srvOpenSheet()`);
  assert.equal($("#servers-down").classList.contains("hidden"), false);
  assert.ok($("#servers-offline-mode-btn").textContent.length > 0);
  $("#servers-offline-mode-btn").click(); await sleep(150);
  assert.equal(a.run(`state.tab`), "connect");
  assert.equal($("#servers-sheet").classList.contains("hidden"), true);
  assert.equal($("#manual-section").classList.contains("hidden"), false);
});

test("SignalingClient: connect-failed при ошибке до open, таймауте и исключении конструктора; после open — нет; registered даёт время рукопожатия", async () => {
  const a = await boot();
  fakeWebSocket(a); const fk = fakeTimers(a);
  a.run(`window.__ev = []; window.__c = new SignalingClient("wss://x.example.com", "me", {}); for (const t of ["connect-failed", "registered", "disconnected"]) __c.addEventListener(t, (e) => __ev.push(t + (e.detail && e.detail.url ? ":" + e.detail.url : ""))); __c.start();`);
  a.run(`__sockets[__sockets.length - 1].__err()`);                       // 1) ошибка до open
  assert.equal(J(a, `__ev[0]`), "connect-failed:wss://x.example.com");
  fk.tick(3000);                                                          // повтор
  fk.tick(8000);                                                          // 2) таймаут рукопожатия 7 с
  assert.equal(J(a, `__ev.filter((x) => x.startsWith("connect-failed")).length`), 2);
  fk.tick(3000);
  a.run(`const s = __sockets[__sockets.length - 1]; s.__open(); s.__recv({ type: "registered", id: "me", online: [] });`);
  assert.equal(J(a, `__ev.filter((x) => x === "registered").length`), 1);
  assert.equal(typeof a.run(`__c.connectMs`), "number");
  a.run(`__sockets[__sockets.length - 1].close()`);                       // 3) закрытие после open — не неудача подключения
  assert.equal(J(a, `__ev.filter((x) => x.startsWith("connect-failed")).length`), 2);
  assert.ok(J(a, `__ev`).includes("disconnected"));
  a.run(`__c.stop(); window.WebSocket = class { constructor() { throw new Error("blocked"); } }; window.__ev2 = []; window.__d = new SignalingClient("wss://y.example.com", "me", {}); __d.addEventListener("connect-failed", () => __ev2.push(1)); __d.start(); __d.stop();`);
  assert.equal(J(a, `__ev2.length`), 1, "исключение конструктора (например, CSP/блокировка) тоже считается неудачей");
});
