// Покрытие app.js: настройки (все переключатели/селекты), PIN/шифрование, папки, глобальный поиск, бэкап/экспорт/импорт, диагностика, паника.
const test = require("node:test");
const assert = require("node:assert/strict");
const { closeAll } = require("./harness");
const { boot, sleep, J, fakeTimers } = require("./cov-helpers");
test.after(closeAll);

function seed(a) {
  a.run(`(() => { Store.myId = "me"; Store.name = "Tester"; window.J = (x) => JSON.parse(JSON.stringify(x));
    const al = ensureContactEntry("alice", "Alice"); al.managed = true; al.messages.push({ id: "a1", from: "them", text: "searchable pizza text", ts: Date.now() - 1000, readAckSent: true });
    ensureContactEntry("bob", "Bobby").managed = true; state.callLog = [{ id: "c1", contactId: "alice", direction: "out", status: "completed", startedAt: Date.now(), durationMs: 5000 }];
    window.confirmSheet = async () => true; window.wipeEverythingAndReload = async () => { window.__wiped = (window.__wiped || 0) + 1; };
    state._firstRenderDone = true; persistContacts(); })()`);
}

test("настройки: каждый чекбокс, селект, ползунок и текстовое поле — без исключений", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  const errs = []; a.window.addEventListener("error", (e) => errs.push(e.message));
  a.run(`state.tab = "settings"; state.settingsCategory = null; renderTab(); window.initSignaling = () => { window.__initSig = 1; }; window.requestMotionPermissionIfNeeded = async () => true;`);
  const n = J(a.run(`(() => { let n = 0; const root = document.getElementById("screen-settings"); const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
    for (const el of root.querySelectorAll("input, select, textarea")) {
      if (["file", "button", "submit"].includes(el.type)) continue; n++;
      try {
        if (el.type === "checkbox") { for (let i = 0; i < 2; i++) { el.checked = !el.checked; fire(el, "change"); } }
        else if (el.tagName === "SELECT") { for (const o of el.options) { el.value = o.value; fire(el, "change"); } }
        else if (el.type === "range") { for (const v of [el.min || 0, el.max || 1]) { el.value = v; fire(el, "input"); fire(el, "change"); } }
        else if (el.type === "color") { el.value = "#336699"; fire(el, "input"); fire(el, "change"); }
        else if (el.type === "time") { el.value = "22:30"; fire(el, "input"); fire(el, "change"); }
        else { for (const v of ["", "valid text", "x".repeat(100)]) { el.value = v; fire(el, "input"); fire(el, "change"); } }
      } catch (e) { window.__exErr = (window.__exErr || []).concat(el.id + ":" + e.message); }
    }
    return n; })()`));
  await sleep(100);
  assert.ok(n > 15, "элементов: " + n); assert.deepEqual(J(a.window.__exErr || []), []); assert.deepEqual(errs, []);
  t.tick(5000);
  a.close();
});

test("настройки: чипы-кнопки (тема, скин, звук, поиск), категории настроек и навигация", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  const errs = []; a.window.addEventListener("error", (e) => errs.push(e.message));
  a.run(`state.tab = "settings"; renderTab();`);
  for (const b of a.document.querySelectorAll(".theme-seg button")) b.click();
  const cats = a.run(`SETTINGS_CATEGORIES.map((c) => c.id)`);
  for (const id of cats) { a.run(`navigateToSettingsCategory(${JSON.stringify(id)});`); assert.equal(a.run(`state.settingsCategory`), id); }
  a.run(`navigateToSettingsCategory(null); updateSettingsCategoryView();`);
  const ss = a.document.querySelector("#settings-search"); if (ss) { for (const v of ["theme", "zzzzqqq", ""]) { ss.value = v; ss.dispatchEvent(new a.window.Event("input")); } }
  assert.deepEqual(errs, []);
  a.close();
});

test("PIN и шифрование данных: включить, сменить, выключить, шифрование, неверный PIN, отмена шторки", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a); a.window.AbortSignal.timeout = () => undefined;
  const flow = async (mode, pin, extra) => { a.document.querySelector("#set-pin-input").value = pin; a.document.querySelector("#set-pin-save-btn").click(); await sleep(extra || 700); };
  const pl = a.document.querySelector("#settings-pinlock"); a.run(`state.tab = "settings"; renderTab();`);
  pl.checked = true; pl.dispatchEvent(new a.window.Event("change"));
  await flow("new", "12"); await flow("new", "12ab"); await flow("new", "123456"); assert.equal(a.run(`Store.pinEnabled`), true);
  // шифрование без/с PIN
  const enc = a.document.querySelector("#settings-encrypt-store"); enc.checked = true; enc.dispatchEvent(new a.window.Event("change"));
  await flow("enc", "000000"); await flow("enc", "123456", 2500); assert.equal(a.run(`SecureStore.isOn()`), true);
  // смена PIN при включённом шифровании
  a.document.querySelector("#change-pin-btn").click(); await flow("x", "000000"); await flow("x", "123456"); await flow("x", "1234", 100); await flow("x", "654321", 3500);
  // выключение шифрования
  enc.checked = false; enc.dispatchEvent(new a.window.Event("change")); await flow("x", "654321", 3500); assert.equal(a.run(`SecureStore.isOn()`), false);
  // отключение PIN
  pl.checked = false; pl.dispatchEvent(new a.window.Event("change")); await flow("x", "000000"); await flow("x", "654321"); assert.equal(a.run(`Store.pinEnabled`), false);
  // шифрование без PIN — отказ; закрытие шторки возвращает переключатели
  enc.checked = true; enc.dispatchEvent(new a.window.Event("change")); assert.equal(enc.checked, false);
  pl.checked = true; pl.dispatchEvent(new a.window.Event("change")); a.document.querySelector("#set-pin-sheet").classList.add("hidden"); await sleep(30); assert.equal(pl.checked, false);
  a.close();
});

test("папки чатов: создание, редактирование, фильтр по папке, удаление; глобальный поиск и переходы", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  a.run(`state.tab = "chats"; state.chatsSegment = "chats"; renderTab();`);
  a.document.querySelector("#chat-folder-add-btn").click(); a.document.querySelector("#folder-create-btn").click(); assert.ok(!a.document.querySelector("#folder-edit-sheet").classList.contains("hidden"));
  a.document.querySelector("#folder-edit-save-btn").click(); assert.equal(a.run(`state.folders.length`), 0);
  a.document.querySelector("#folder-edit-name").value = "Work"; a.document.querySelector("#folder-edit-member-list .folder-member-check").checked = true; a.document.querySelector("#folder-edit-save-btn").click(); assert.equal(a.run(`state.folders.length`), 1);
  const chip = a.document.querySelector("#chat-filters-custom .chat-filter-chip"); chip.click(); assert.ok(a.run(`state.chatFilter.startsWith("folder:")`));
  a.document.querySelector("#chat-folder-add-btn").click(); a.document.querySelector("#folder-manage-list .forward-row").click(); assert.ok(!a.document.querySelector("#folder-edit-delete-btn").classList.contains("hidden"));
  a.document.querySelector("#folder-edit-name").value = "Work2"; a.document.querySelector("#folder-edit-save-btn").click(); assert.equal(a.run(`state.folders[0].name`), "Work2");
  a.document.querySelector("#chat-folder-add-btn").click(); a.document.querySelector("#folder-manage-list .forward-row").click(); a.document.querySelector("#folder-edit-delete-btn").click(); assert.equal(a.run(`state.folders.length`), 0); assert.equal(a.run(`state.chatFilter`), "all");
  a.run(`deleteFolderEdit(); state.folders = [{ id: 1, name: 2 }, { id: "ok", name: "n", contactIds: ["alice"] }, null]; persistChatFolders(); loadChatFolders();`); assert.equal(a.run(`state.folders.length`), 1);
  a.run(`Store.chatFoldersJson = "{bad"; loadChatFolders(); Store.chatFoldersJson = "5"; loadChatFolders();`);
  // глобальный поиск
  a.run(`state.tab = "settings"; renderTab(); window.jumpToMessageInChat = (c, m) => { window.__jump = [c, m]; }; window.beginCall = (id) => { window.__bc = id; }; window.openContactCard = (id) => { window.__oc = id; };`);
  a.run(`openGlobalSearch("pizza");`); assert.ok(!a.document.querySelector("#global-search-sheet").classList.contains("hidden")); const rows = [...a.document.querySelectorAll("#global-search-results .forward-row, #global-search-results button")]; assert.ok(rows.length >= 1);
  for (const q of ["alice", "bobby", "theme", "pizza", "", "zzzzzzz"]) { a.run(`renderGlobalSearchResults(${JSON.stringify(q)});`); for (const r of [...a.document.querySelectorAll("#global-search-results button")]) { r.click(); a.run(`openGlobalSearch(${JSON.stringify(q)});`); } }
  const gsi = a.document.querySelector("#global-search-input"); gsi.value = "alice"; gsi.dispatchEvent(new a.window.Event("input")); a.run(`closeGlobalSearch();`);
  a.document.dispatchEvent(new a.window.KeyboardEvent("keydown", { key: "k", ctrlKey: true, cancelable: true })); a.document.dispatchEvent(new a.window.KeyboardEvent("keydown", { key: "k", metaKey: true, cancelable: true })); a.document.dispatchEvent(new a.window.KeyboardEvent("keydown", { key: "Escape" }));
  const gb = a.document.querySelector("#global-search-btn"); if (gb) gb.click();
  a.close();
});

test("бэкап: экспорт с паролем и без, импорт (обычный, зашифрованный, неверный пароль, мусор), воркер шифрования", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  const dl = []; a.run(`window.downloadBlob = (b, n) => { window.__dl = { name: n, blob: b }; };`);
  // экспорт без пароля («Без пароля») и отмена
  const exp = async (action, pw) => { const p = a.run(`exportBackup()`); await sleep(20); if (action === "confirm") { a.document.querySelector("#backup-password-input").value = pw; a.document.querySelector("#backup-password-confirm").click(); } else if (action === "skip") a.document.querySelector("#backup-password-skip").click(); else if (action === "close") a.document.querySelector("#backup-password-sheet").classList.add("hidden"); await p; };
  await exp("skip"); const plain = JSON.parse(await a.window.__dl.blob.text()); assert.ok(Object.keys(plain).some((k) => k.startsWith("ether."))); a.window.__dl = null;
  await exp("close"); assert.equal(a.window.__dl, null);
  // шифрованный: сначала без Worker (откат на основной поток), затем с «воркером»
  await exp("confirm", "pw-12345", 0); const enc = JSON.parse(await a.window.__dl.blob.text()); assert.equal(enc.etherEncryptedBackup, true); assert.ok(enc.envelope && enc.salt);
  const fs = require("fs"); const path = require("path"); const workerSrc = fs.readFileSync(path.join(__dirname, "..", "js", "crypto-worker.js"), "utf8").replace('importScripts("crypto-helper.js");', "");
  a.run(`window.Worker = class { constructor(url) { this.url = url; const self_ = this; const scope = { onmessage: null, postMessage: (m) => { __realTO.call(window, () => self_.onmessage && self_.onmessage({ data: m }), 0); } }; this.__scope = scope; (new Function("self", "crypto", "CryptoHelper", "TextEncoder", ${JSON.stringify("PLACEHOLDER")}.length ? ${JSON.stringify(workerSrc)} : ""))(scope, crypto, CryptoHelper, TextEncoder); }
    postMessage(m) { this.__scope.onmessage({ data: m }); } };`);
  a.run(`__cryptoWorker = null; __cryptoWorkerFailed = false;`);
  await exp("confirm", "pw-67890"); const enc2 = JSON.parse(await a.window.__dl.blob.text()); assert.equal(enc2.etherEncryptedBackup, true);
  // импорт
  const imp = async (obj, pw, { confirm = true } = {}) => { a.run(`window.confirmSheet = async () => ${confirm}; window.__reloaded = 0;`); const file = { text: async () => (typeof obj === "string" ? obj : JSON.stringify(obj)) };
    const p = a.run(`importBackupFile(window.__file)`.replace("window.__file", "__f")); return p; };
  a.window.__f = { text: async () => "garbage{" }; await a.run(`importBackupFile(__f)`);
  a.window.__f = { text: async () => JSON.stringify({ foo: "bar" }) }; await a.run(`importBackupFile(__f)`);
  a.window.__f = { text: async () => "5" }; await a.run(`importBackupFile(__f)`);
  a.run(`window.confirmSheet = async () => false;`); a.window.__f = { text: async () => JSON.stringify({ "ether.name": "Imported" }) }; await a.run(`importBackupFile(__f)`); assert.notEqual(a.run(`Store.name`), "Imported");
  a.run(`window.confirmSheet = async () => true;`);
  // зашифрованный импорт: неверный пароль / отмена / верный
  a.window.__f = { text: async () => JSON.stringify(enc2) };
  let p = a.run(`importBackupFile(__f)`); await sleep(20); a.document.querySelector("#backup-password-input").value = "wrong"; a.document.querySelector("#backup-password-confirm").click(); await p;
  p = a.run(`importBackupFile(__f)`); await sleep(20); a.document.querySelector("#backup-password-sheet").classList.add("hidden"); await p;
  p = a.run(`importBackupFile(__f)`); await sleep(20); a.document.querySelector("#backup-password-input").value = "pw-67890"; a.document.querySelector("#backup-password-input").dispatchEvent(new a.window.KeyboardEvent("keydown", { key: "Enter", cancelable: true })); await p;
  assert.equal(a.run(`Store.name`), "Tester"); // восстановленное из файла имя (то же, что экспортировали)
  // importBackup через input
  a.window.__f = { text: async () => JSON.stringify({ "ether.name": "ViaInput", "ether.myId": "x" }) };
  await a.run(`importBackup({ target: { files: [__f], value: "x" } })`); await a.run(`importBackup({ target: { files: [], value: "x" } })`);
  // воркер: ошибки
  const w = J(await a.run(`(async () => { const o = {}; __cryptoWorker = null; __cryptoWorkerFailed = true; o.nullWorker = getCryptoWorker(); try { await runInCryptoWorker("encrypt", {}); } catch (e) { o.err = e.message; }
    __cryptoWorkerFailed = false; window.Worker = undefined; __cryptoWorker = null; o.noCtor = getCryptoWorker(); __cryptoWorkerFailed = false;
    window.Worker = class { constructor() {} postMessage(m) { __realTO.call(window, () => this.onmessage({ data: { reqId: m.reqId, ok: false, error: "boom" } }), 0); } };
    __cryptoWorker = null; try { await runInCryptoWorker("encrypt", {}); } catch (e) { o.boom = e.message; } __cryptoWorker.onmessage({ data: { reqId: 999, ok: true } }); __cryptoWorker.onmessage({});
    const pr = runInCryptoWorker("decrypt", {}).catch((e) => e.message); __cryptoWorker.onerror(); o.crashed = await pr; o.failedFlag = __cryptoWorkerFailed; return o; })()`));
  assert.equal(w.nullWorker, null); assert.equal(w.err, "crypto worker unavailable"); assert.equal(w.boom, "boom"); assert.equal(w.crashed, "crypto worker crashed"); assert.equal(w.failedFlag, true);
  a.close();
});

test("диагностика и хранилище: тексты, экспорт, очистка старых медиа, перебор отладочных кнопок", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  a.run(`window.downloadBlob = (b, n) => { window.__dl = n; };`);
  const r = J(await a.run(`(async () => { const o = {};
    o.diag = buildDiagnosticsText().length > 10; o.webrtc = buildWebRtcText().length >= 0; o.logs = buildLogsText().length >= 0; o.storage = buildStorageText().length > 10; o.full = buildFullDiagnosticsText().includes("===");
    exportFullDiagnostics(); o.dl = window.__dl;
    const al = state.contacts.get("alice"); const old = Date.now() - 40 * 86400000; al.messages.push({ id: "old1", from: "them", text: "", ts: old, file: { name: "o.png", mime: "image/png", size: 100, kind: "image" } }, { id: "old2", from: "me", text: "", ts: old, file: { name: "o.mp3", mime: "audio/webm", size: 50, kind: "audio" } }, { id: "new1", from: "me", text: "", ts: Date.now(), file: { name: "n.png", mime: "image/png", size: 10, kind: "image" } }, { id: "oldv", from: "me", text: "", ts: old, file: { name: "v.mp4", mime: "video/mp4", size: 70, kind: "video" } }, { id: "oldd", from: "me", text: "", ts: old, file: { name: "d.pdf", mime: "application/pdf", size: 30, kind: "file" } });
    o.storageWithFiles = buildStorageText(); o.cleared = await clearOldMedia(30); o.left = al.messages.filter((m) => m.file).length; await clearOldMedia(0); await clearOldMedia(-1);
    return o; })()`));
  assert.ok(r.diag && r.storage && r.full); assert.ok(r.dl.startsWith("ether-diagnostics-")); assert.ok(r.left >= 1);
  // паника: встряска, отмена, тап по логотипу
  a.run(`window.performPanicWipe = () => { window.__panic = (window.__panic || 0) + 1; };`);
  a.run(`handleShakeMotion({}); handleShakeMotion({ accelerationIncludingGravity: { x: 1, y: 1, z: 1 } }); handleShakeMotion({ accelerationIncludingGravity: { x: 30, y: 30, z: 30 } }); handleShakeMotion({ accelerationIncludingGravity: { x: 30, y: 30, z: 30 } });`);
  assert.ok(!a.document.querySelector("#panic-shake-banner").classList.contains("hidden")); a.run(`cancelPanicShakeWipe();`); assert.ok(a.document.querySelector("#panic-shake-banner").classList.contains("hidden"));
  a.run(`__shakeLastTrigger = 0; triggerPanicShakeWipe(); triggerPanicShakeWipe();`); t.tick(5000); assert.equal(a.window.__panic, 1);
  a.run(`wirePanicShake(); unwirePanicShake();`);
  const logo = a.document.querySelector("#about-app-logo"); if (logo) { for (let i = 0; i < 5; i++) logo.click(); await sleep(30); assert.equal(a.window.__panic, 2); }
  a.run(`Store.debugHidden = true; applyDebugTabVisibility();`); const nt = a.document.querySelector("#nav-title"); for (let i = 0; i < 5; i++) nt.click(); assert.equal(a.run(`Store.debugHidden`), false);
  // экран отладки: безопасные кнопки
  a.run(`state.tab = "debug"; renderTab();`);
  for (const id of ["debug-refresh-btn", "debug-copy-btn", "debug-export-btn", "debug-clear-log-btn", "debug-export-backup-btn", "debug-storage-refresh-btn"]) { const b = a.document.getElementById(id); if (b) b.click(); await sleep(10); }
  a.run(`downloadBlob(new Blob(["x"]), "n.txt"); exportChat("alice"); exportChat("nope");`); t.tick(2000);
  a.close();
});

test("удаление: контакт (в звонке, с очередями), аккаунт и сброс — стираются данные и IndexedDB", async () => {
  const a = await boot(); const t = fakeTimers(a); seed(a);
  a.run(`const al = state.contacts.get("alice"); al.messages.push({ id: "f1", from: "me", text: "", ts: 1, file: { name: "x", mime: "image/png", size: 1, kind: "image" } }); addToOutbox("o1", "alice", {}); pendingNoKey.set("alice", [{ msgId: "p", payload: {} }]); groupDeliveryMap.set("d1", { groupId: "g", contentId: "c", to: "alice" });
    state.scheduledMessages = [{ id: "s", contactId: "alice", text: "z", sendAt: 1 }]; state.folders = [{ id: "f", name: "F", contactIds: ["alice"] }]; state.lastSeen.alice = 1; state.drafts.alice = "d"; state.callId = "alice"; window.closeCallScreen = (r) => { state.callId = null; window.__cc = r; };
    const audio = document.createElement("audio"); audio.id = "remote-audio-alice"; document.body.appendChild(audio);`);
  a.run(`deleteContact("alice");`); assert.ok(!a.run(`state.contacts.has("alice")`)); assert.equal(a.window.__cc, "failed"); assert.ok(a.run(`recentlyDeletedIds.has("alice")`)); assert.equal(a.run(`outbox.size`), 0); assert.equal(a.run(`state.folders[0].contactIds.length`), 0);
  a.run(`const self_ = ensureContactEntry("selfy", "Self"); self_.isSelf = true; deleteContact("selfy"); state.contacts.set("gdel", { id: "gdel", isGroup: true, members: [{ id: "me" }], messages: [] }); deleteContact("gdel");`); assert.ok(a.run(`state.contacts.has("selfy")`));
  // настоящее стирание — в последнюю очередь
  a.run(`delete window.wipeEverythingAndReload;`);
  return (async () => {
    a.window.eval && 0;
    await a.run(`(async () => { Store.name = "ToBeWiped"; await IDB.set("probe", "x"); })()`);
    // wipeEverythingAndReload — функция страницы; stub-а в window больше нет (delete не снимает объявление), поэтому вызываем оригинал через новое окно
    const b = await boot(); fakeTimers(b);
    await b.run(`performFullAccountWipe()`).catch(() => {});
    assert.equal(b.run(`__wiping`), true); assert.equal(b.run(`localStorage.getItem("ether.name")`), null);
    a.close(); b.close();
  })();
});
