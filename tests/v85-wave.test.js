// V.85: дизайн и UX — разделы настроек и «Связь», масштаб, значок защиты, альбомы, редактор фото, свайп «назад», звонок, «Прочитано» из уведомления.
const test = require("node:test");
const assert = require("node:assert/strict");
const { closeAll } = require("./harness");
const { boot, sleep, J } = require("./cov-helpers");
test.after(closeAll);

test("настройки: разделы «Чаты» и «Связь», строки на своих местах, поиск сервера, масштаб", async () => {
  const a = await boot(); const d = a.document;
  a.run(`state.tab = "settings"; renderTab();`);
  const cats = J(a.run(`SETTINGS_CATEGORIES.map((c) => c.id)`));
  assert.ok(cats.includes("chats") && cats.includes("connection"));
  assert.ok(d.querySelector('#p85-chats-group #p84-ctrlEnter'), "Ctrl+Enter — в «Чатах»");
  assert.ok(d.querySelector('#p85-a11y-group #p84-highContrast'), "контраст — во «Внешнем виде → Доступность»");
  assert.equal(d.querySelector("#signaling-status-dot").closest(".settings-group").dataset.settingsCategory, "connection");
  assert.ok(d.querySelectorAll('.settings-category-row[data-category="connection"]').length === 1);
  a.run(`openSettingsCategory("connection")`);
  assert.equal(d.querySelector("#p85-conn-group").classList.contains("category-hidden"), false);
  assert.ok(d.querySelector("#p85-conn-card").textContent.length > 0);
  a.run(`window.srvProbeAll = async () => ({ "wss://a": { ok: true, rtt: 50 }, "wss://b": { ok: false } }); window.srvRefreshSigned = async () => {};`);
  assert.equal(await a.run(`p85FindServer()`), 1);
  // масштаб
  assert.match(d.querySelector('meta[name="viewport"]').getAttribute("content"), /user-scalable=no/);
  const z = d.querySelector("#p85-zoom"); z.checked = true; z.dispatchEvent(new a.window.Event("change"));
  assert.doesNotMatch(d.querySelector('meta[name="viewport"]').getAttribute("content"), /user-scalable/);
  assert.ok(d.documentElement.classList.contains("a11y-zoom"));
  const ev = new a.window.Event("gesturestart", { cancelable: true }); d.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, false, "щипок разрешён");
  a.close();
});

test("чат: значок защиты, свайп «назад» от края, альбом из подряд идущих фото", async () => {
  const a = await boot(); const d = a.document;
  a.run(`(() => { const c = ensureContactEntry("bob", "Bob"); c.managed = true; c.publicKey = "K1"; const t = Date.now() - 10000;
    for (let i = 0; i < 3; i++) c.messages.push({ id: "ph" + i, from: "them", ts: t + i * 1000, file: { name: "p" + i + ".jpg", mime: "image/jpeg", kind: "image", size: 10 } });
    c.messages.push({ id: "tx", from: "them", ts: t + 5000, text: "привет" });
    state._firstRenderDone = true; state.tab = "chats"; state.chatId = "bob"; renderTab(); })()`);
  const b = d.querySelector("#p85-sec-badge"); assert.ok(b); assert.equal(b.dataset.state, "e2e");
  a.run(`state.contacts.get("bob").verifiedKey = "K1"; renderTab();`);
  assert.equal(d.querySelector("#p85-sec-badge").dataset.state, "verified");
  a.run(`state.contacts.get("bob").pendingKey = "K2"; renderTab();`);
  assert.equal(d.querySelector("#p85-sec-badge").dataset.state, "changed");
  const al = d.querySelector("#chat-messages .p85-album");
  assert.ok(al, "альбом собран"); assert.equal(al.querySelectorAll(".p85-album-item").length, 3); assert.ok(al.classList.contains("n3"));
  // свайп от левого края закрывает чат
  const scr = d.querySelector("#screen-chat");
  const te = (type, x) => { const e = new a.window.Event(type, { bubbles: true }); e.touches = [{ clientX: x, clientY: 300 }]; e.changedTouches = [{ clientX: x, clientY: 300 }]; scr.dispatchEvent(e); };
  te("touchstart", 10); te("touchmove", 80); te("touchend", 140);
  assert.equal(a.run(`state.chatId`), null);
  a.close();
});

test("отправка нескольких фото — шторка альбома с подписью у первого; редактор фото включается для картинки", async () => {
  const a = await boot(); const d = a.document;
  a.run(`(() => { const c = ensureContactEntry("bob", "Bob"); c.managed = true; state._firstRenderDone = true; state.tab = "chats"; state.chatId = "bob"; renderTab();
    window.__sent = []; window.sendFileMessage = async (id, f, o) => { window.__sent.push([id, f.name, o && o.caption]); }; })()`);
  a.run(`handlePickedFiles([new File([new Uint8Array(4)], "a.jpg", { type: "image/jpeg" }), new File([new Uint8Array(4)], "b.png", { type: "image/png" })])`);
  const sh = d.querySelector("#p85-album-sheet"); assert.ok(sh && !sh.classList.contains("hidden"));
  assert.equal(sh.querySelectorAll(".p85-album-cell").length, 2);
  sh.querySelector("#p85-album-caption").value = "море"; sh.querySelector("#p85-album-send").click(); await sleep(50);
  assert.deepEqual(J(a.run(`window.__sent`)), [["bob", "a.jpg", "море"], ["bob", "b.png", ""]]);
  a.run(`openMediaComposeSheet(new File([new Uint8Array(4)], "c.jpg", { type: "image/jpeg" }))`);
  const bar = d.querySelector("#p85-edit-bar"); assert.ok(bar && !bar.classList.contains("hidden"));
  assert.equal(bar.querySelectorAll("[data-edit]").length, 5);
  a.close();
});

test("звонок: своё видео прилипает к углу и запоминает его; тап меняет местами", async () => {
  const a = await boot(); const d = a.document;
  const lv = d.querySelector("#call-local-video"), scr = d.querySelector("#call-screen");
  assert.equal(lv.dataset.corner, "tr");
  const pe = (type, x, y) => { const e = new a.window.Event(type, { bubbles: true }); e.clientX = x; e.clientY = y; e.pointerId = 1; lv.dispatchEvent(e); };
  pe("pointerdown", 300, 50); pe("pointermove", 40, 600); pe("pointerup", 40, 600);
  assert.equal(lv.dataset.corner, "bl"); assert.equal(a.run(`localStorage.getItem("ether.call.corner")`), "bl");
  pe("pointerdown", 40, 600); pe("pointerup", 41, 601);
  assert.ok(scr.classList.contains("p85-swapped"));
  a.close();
});

test("«Прочитано» из уведомления при закрытом приложении применяется при открытии", async () => {
  const a = await boot();
  a.run(`(() => { const c = ensureContactEntry("bob", "Bob"); c.managed = true; c.messages.push({ id: "u1", from: "them", text: "x", ts: Date.now() }); c.unread = 1; state._firstRenderDone = true;
    window.__marked = []; window.markThreadRead = (c) => { window.__marked.push(c.id); };
    window.caches = { open: async () => ({ match: async () => ({ json: async () => ["bob", "nobody"] }), delete: async () => true }) }; })()`);
  assert.equal(await a.run(`p85ApplyPendingReads()`), 1);
  assert.deepEqual(J(a.run(`window.__marked`)), ["bob"]);
  a.close();
});
