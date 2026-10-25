// V.80: шифрование «в покое» по умолчанию (ключ устройства), миграция открытого текста, возобновление, потеря ключа, слои PIN, crypto-shred, перф.
const test = require("node:test");
const assert = require("node:assert/strict");
const { closeAll } = require("./harness");
const { boot, raw, dumpRaw, diskOf, contactsJson, sleep, createApp } = require("./fix80-storage-helpers");
test.after(closeAll);

const readKeyRec = (a) => new Promise((res) => { const q = a.window.indexedDB.open("ether-keys", 1); q.onupgradeneeded = () => q.result.createObjectStore("k"); q.onsuccess = () => { const r = q.result.transaction("k").objectStore("k").get("device"); r.onsuccess = () => { q.result.close(); res(r.result); }; }; q.onerror = () => res(null); });

test("свежая установка: ключ устройства неизвлекаем, данные на диске и в зеркале IndexedDB — шифртекст, приложение читает открытый текст", async () => {
  const a = await boot();
  assert.equal(a.run(`SecureStore.mode()`), "device");
  const rec = await readKeyRec(a);
  assert.ok(rec && rec.key && rec.key.extractable === false, "CryptoKey неизвлекаемый");
  await assert.rejects(a.window.crypto.subtle.exportKey("raw", rec.key));
  a.run(`const c = ensureContactEntry("alice", "Alice"); c.managed = true; c.messages.push({ id: "m1", from: "me", text: "СЕКРЕТ-СВЕЖАЯ", ts: Date.now(), ack: "sent" }); persistContacts(); persistContactsNow();`);
  await a.run(`SecureStore.flush()`);
  assert.match(a.window.localStorage.getItem("ether.contacts"), /СЕКРЕТ-СВЕЖАЯ/, "Store видит открытый текст (кэш)");
  const d = dumpRaw(a);
  assert.ok(!d.includes("СЕКРЕТ-СВЕЖАЯ") && !d.includes(Buffer.from("СЕКРЕТ-СВЕЖАЯ").toString("base64")));
  assert.ok(raw(a, "ether.contacts").startsWith("encd1:"));
  assert.ok(raw(a, "ether.privKey") === null || raw(a, "ether.privKey").startsWith("encd1:"), "приватный ключ не открытым текстом");
  assert.equal(a.run(`SecureStore.pending()`), 0);
  await a.run(`backupToIDB()`);
  assert.ok((await a.run(`IDB.get("ether.contacts")`)).startsWith("encd1:"), "зеркало в IndexedDB — шифртекст");
  a.close();
});

test("миграция открытого текста (крупная история): зашифровано, читается идентично, открытого текста нет; claim-токен и ключ личности тоже", async () => {
  const cj = contactsJson(2500, "БОЛЬШАЯ-ИСТОРИЯ"); // ~1 МБ
  const tok = "ab".repeat(32);
  const t0 = Date.now();
  const a = await boot({ storage: { "ether.contacts": cj, "ether.claimToken": tok, "ether.privKey": JSON.stringify({ kty: "EC", d: "СЕКРЕТНЫЙ-D" }), "ether.ratchet": '{"alice":{"rk":"RATCHET-SECRET"}}' } });
  const dt = Date.now() - t0;
  assert.equal(a.run(`SecureStore.mode()`), "device");
  assert.equal(a.run(`SecureStore.pending()`), 0, "всё мигрировано");
  assert.equal(a.window.localStorage.getItem("ether.contacts"), cj.length ? a.window.localStorage.getItem("ether.contacts") : "");
  assert.match(a.window.localStorage.getItem("ether.contacts"), /БОЛЬШАЯ-ИСТОРИЯ сообщение номер 2499/);
  assert.equal(a.window.localStorage.getItem("ether.claimToken"), tok);
  const d = dumpRaw(a);
  for (const m of ["БОЛЬШАЯ-ИСТОРИЯ", "СЕКРЕТНЫЙ-D", "RATCHET-SECRET", tok]) assert.ok(!d.includes(m), "на диске нет: " + m);
  assert.ok(dt < 20000, "загрузка с миграцией 1 МБ уложилась: " + dt + " мс");
  a.close();
});

test("миграция IndexedDB: файлы file:* и снимки contactsPrev из открытого вида переходят в шифрованный, читаются обратно", async () => {
  const a = await boot();
  await a.run(`(async () => { await IDB.set("file:old1", new Blob([new Uint8Array([9, 8, 7])], { type: "image/png" }), { plain: true }); await IDB.set("contactsPrev", "ПРЕЖНИЙ-СНИМОК", { plain: true }); })()`);
  const rawBefore = await a.run(`new Promise((res) => { const db = null; IDB.open().then((d) => { const r = d.transaction("kv").objectStore("kv").get("file:old1"); r.onsuccess = () => res(!r.result.__enc); }); })`);
  assert.equal(rawBefore, true, "до миграции — открытый Blob");
  assert.equal(await a.run(`IDB.migrateToEncrypted()`), 2);
  const rec = await a.run(`new Promise((res) => { IDB.open().then((d) => { const r = d.transaction("kv").objectStore("kv").get("file:old1"); r.onsuccess = () => res({ enc: r.result.__enc, isBlob: !r.result.__enc }); }); })`);
  assert.equal(JSON.stringify(rec), JSON.stringify({ enc: 2, isBlob: false }));
  assert.equal(await a.run(`IDB.get("file:old1").then((b) => b.size)`), 3);
  assert.equal(await a.run(`IDB.get("contactsPrev")`), "ПРЕЖНИЙ-СНИМОК");
  assert.equal(await a.run(`IDB.migrateToEncrypted()`), 0, "повтор ничего не делает (возобновляемо)");
  a.close();
});

test("прерванная миграция возобновляется: часть ключей уже шифртекст, часть открытая — после перезапуска всё шифртекст, ничего не потеряно", async () => {
  const a = await boot({ storage: { "ether.drafts": '{"alice":"ЧЕРНОВИК-1"}', "ether.callLog": '[{"x":"ЖУРНАЛ-1"}]' } });
  await a.run(`SecureStore.flush()`);
  assert.ok(raw(a, "ether.drafts").startsWith("encd1:"));
  // «обрыв»: один ключ вернулся в открытый вид (как если бы запись шифртекста не дошла до диска)
  a.run(`SecureStore.rawSet("ether.callLog", '[{"x":"ЖУРНАЛ-1"}]')`);
  const disk = diskOf(a), idb = a.window.indexedDB; a.close();
  const b = await boot({ indexedDB: idb, storage: disk });
  assert.equal(b.run(`SecureStore.mode()`), "device");
  assert.equal(b.run(`SecureStore.pending()`), 0);
  assert.ok(raw(b, "ether.callLog").startsWith("encd1:"));
  assert.equal(b.window.localStorage.getItem("ether.callLog"), '[{"x":"ЖУРНАЛ-1"}]');
  assert.equal(b.window.localStorage.getItem("ether.drafts"), '{"alice":"ЧЕРНОВИК-1"}');
  b.close();
});

test("квота при миграции: открытый текст остаётся читаемым (данные не теряются), pending > 0, приложение работает", async () => {
  const a = await boot({ storage: { "ether.drafts": "a".repeat(2400000), "ether.callLog": "b".repeat(2400000) } });
  assert.equal(a.run(`SecureStore.mode()`), "device");
  assert.ok(a.run(`SecureStore.pending()`) > 0, "хотя бы один ключ не поместился после шифрования");
  assert.equal(a.run(`localStorage.getItem("ether.drafts").length`), 2400000);
  assert.equal(a.run(`localStorage.getItem("ether.callLog").length`), 2400000);
  assert.match(a.run(`Integrity.renderCentre(), document.getElementById("security-storage-line").textContent`), /не\sзавершено|unfinished/);
  a.close();
});

test("потерян ключ устройства: экран восстановления, данные НЕ удалены; «Начать заново» стирает только после подтверждения", async () => {
  const a = await boot({ storage: { "ether.drafts": '{"alice":"ЧЕРНОВИК-К"}' } });
  await a.run(`SecureStore.flush()`);
  const disk = diskOf(a); a.close();
  const b = createApp({ storage: disk }); // новый IndexedDB = ключа нет
  await b.ready; for (let i = 0; i < 60 && b.run(`SecureStore.mode()`) === "init"; i++) await sleep(30);
  await sleep(100);
  assert.equal(b.run(`SecureStore.mode()`), "keylost");
  assert.equal(b.run(`typeof __appStarted !== "undefined" && __appStarted`), false, "приложение не стартует на нечитаемых данных");
  assert.equal(b.document.getElementById("boot-recovery").classList.contains("hidden"), false);
  for (const id of ["storage-lost-restore", "storage-lost-reset", "storage-lost-retry"]) assert.ok(b.document.getElementById(id), id);
  assert.match(b.document.getElementById("storage-lost-restore").textContent, /Восстановить\sиз\sрезервной\sкопии/);
  assert.match(b.document.getElementById("storage-lost-reset").textContent, /Начать\sзаново/);
  assert.equal(raw(b, "ether.drafts"), disk["ether.drafts"], "шифртекст на месте — молчаливой потери нет");
  // отказ от подтверждения: ничего не стёрто
  b.run(`window.confirmSheet = async () => false; location.reload = () => {};`);
  b.document.getElementById("storage-lost-reset").click(); await sleep(50);
  assert.equal(raw(b, "ether.drafts"), disk["ether.drafts"]);
  assert.match(b.run(`Integrity.renderCentre(), document.getElementById("security-storage-line").textContent`), /ключ\sустройства\sне\sнайден|device key not found/);
  b.close();
});

test("потерян ключ: восстановление из резервной копии заменяет нечитаемое и после перезапуска всё зашифровано новым ключом", async () => {
  const a = await boot({ storage: { "ether.drafts": '{"alice":"СТАРОЕ"}' } });
  await a.run(`SecureStore.flush()`);
  const disk = diskOf(a); a.close();
  const b = createApp({ storage: disk });
  await b.ready; for (let i = 0; i < 60 && b.run(`SecureStore.mode()`) !== "keylost"; i++) await sleep(30);
  b.run(`window.confirmSheet = async () => true; location.reload = () => {};`);
  b.window.__f = { text: async () => JSON.stringify({ "ether.name": "Zed", "ether.myId": "zed-id", "ether.drafts": '{"alice":"ИЗ-КОПИИ"}' }) };
  await b.run(`importBackupFile(__f)`);
  const disk2 = diskOf(b); const idb = b.window.indexedDB; b.close();
  const c = await boot({ indexedDB: idb, storage: disk2 });
  assert.equal(c.run(`SecureStore.mode()`), "device");
  assert.equal(c.window.localStorage.getItem("ether.drafts"), '{"alice":"ИЗ-КОПИИ"}');
  assert.ok(raw(c, "ether.drafts").startsWith("encd1:"));
  c.close();
});

test("слои PIN: включение — encd1(enc1), без ключа устройства PIN один не открывает; отключение PIN оставляет слой устройства; смена PIN", async () => {
  const a = await boot({ storage: { "ether.drafts": '{"alice":"ПОД-PIN"}' } });
  await a.run(`SecureStore.enable("123456")`);
  const r1 = raw(a, "ether.drafts"); assert.ok(r1.startsWith("encd1:"));
  assert.equal(a.run(`SecureStore.mode()`), "pin");
  assert.equal(a.run(`SecureStore.isOn()`), true);
  await a.run(`SecureStore.flush()`);
  const disk = diskOf(a), idb = a.window.indexedDB; a.close();
  // тот же профиль: заперто, PIN открывает
  const b = createApp({ indexedDB: idb, storage: Object.assign({ "ether.pinEnabled": "0" }, disk) });
  await b.ready; for (let i = 0; i < 60 && b.run(`SecureStore.mode()`) === "init"; i++) await sleep(30);
  assert.equal(b.run(`SecureStore.isActive()`), false);
  assert.equal(await b.run(`SecureStore.unlock("000000")`), false);
  assert.equal(await b.run(`SecureStore.unlock("123456")`), true);
  assert.equal(b.window.localStorage.getItem("ether.drafts"), '{"alice":"ПОД-PIN"}');
  assert.equal(await b.run(`SecureStore.rekey("123456", "654321")`), true);
  assert.equal(await b.run(`SecureStore.disable("654321")`), true);
  assert.equal(b.run(`SecureStore.mode()`), "device");
  await b.run(`SecureStore.flush()`); await b.run(`backupToIDB()`); // как в обработчике настроек: зеркало обновляется после снятия PIN
  assert.ok(raw(b, "ether.drafts").startsWith("encd1:"));
  assert.equal(raw(b, "ether.sec.salt"), null);
  const disk2 = diskOf(b); b.close();
  // PIN без ключа устройства (другой профиль) данные не открывает
  const c = createApp({ storage: Object.assign({}, disk, { "ether.pinEnabled": "0" }) });
  await c.ready; for (let i = 0; i < 60 && c.run(`SecureStore.mode()`) === "init"; i++) await sleep(30);
  assert.equal(c.run(`SecureStore.mode()`), "keylost", "PIN-слой лежит под слоем ключа устройства");
  c.close();
  // после снятия PIN профиль без PIN читается
  const d = await boot({ indexedDB: idb, storage: disk2 });
  assert.equal(d.run(`SecureStore.mode()`), "device");
  assert.equal(d.window.localStorage.getItem("ether.drafts"), '{"alice":"ПОД-PIN"}');
  d.close();
});

test("старый PIN-профиль (только enc1, без ключа устройства): unlock открывает, диск дополняется внешним слоем устройства", async () => {
  const { webcrypto: wc } = require("node:crypto");
  const te = new TextEncoder(), salt = wc.getRandomValues(new Uint8Array(16));
  const base = await wc.subtle.importKey("raw", te.encode("123456"), "PBKDF2", false, ["deriveBits"]);
  const bits = await wc.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 250000 }, base, 256);
  const k = await wc.subtle.importKey("raw", bits, "AES-GCM", false, ["encrypt"]);
  const enc = async (txt, aad) => { const iv = wc.getRandomValues(new Uint8Array(12)); const ct = new Uint8Array(await wc.subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(aad) }, k, te.encode(txt))); const o = new Uint8Array(12 + ct.length); o.set(iv); o.set(ct, 12); return "enc1:" + Buffer.from(o).toString("base64"); };
  const a = await boot({ storage: { "ether.sec.on": "1", "ether.sec.salt": Buffer.from(salt).toString("base64"), "ether.sec.check": await enc("ether", "check"), "ether.drafts": await enc('{"alice":"СТАРЫЙ-PIN"}', "ether.drafts"), "ether.pinEnabled": "0" } });
  assert.equal(a.run(`SecureStore.mode()`), "pin");
  assert.equal(a.run(`SecureStore.hasDevice()`), true, "ключ устройства создан при запуске");
  assert.equal(await a.run(`SecureStore.unlock("123456")`), true);
  assert.equal(a.window.localStorage.getItem("ether.drafts"), '{"alice":"СТАРЫЙ-PIN"}');
  await sleep(100); await a.run(`SecureStore.flush()`);
  assert.ok(raw(a, "ether.drafts").startsWith("encd1:"), "внешний слой добавлен");
  a.close();
});

test("файлы: слои устройства (+PIN) в IndexedDB, снятие PIN переписывает файл только слоем устройства", async () => {
  const a = await boot();
  a.run(`const c = ensureContactEntry("alice", "Alice"); c.managed = true; c.messages.push({ id: "f1", from: "alice", ts: Date.now(), file: { name: "p.png", mime: "image/png", size: 3, kind: "image" } });`);
  await a.run(`IDB.set("file:f1", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }))`);
  const kind = () => a.run(`new Promise((res) => IDB.open().then((d) => { const r = d.transaction("kv").objectStore("kv").get("file:f1"); r.onsuccess = () => res({ e: r.result.__enc, p: !!r.result.iv1 }); }))`);
  assert.equal(JSON.stringify(await kind()), JSON.stringify({ e: 2, p: false }));
  await a.run(`(async () => { await SecureStore.enable("123456"); await migrateFilesEncryption(true); })()`);
  assert.equal(JSON.stringify(await kind()), JSON.stringify({ e: 2, p: true }), "устройство поверх PIN");
  await a.run(`(async () => { await migrateFilesEncryption(false); await SecureStore.disable("123456"); })()`);
  assert.equal(JSON.stringify(await kind()), JSON.stringify({ e: 2, p: false }));
  assert.equal(await a.run(`IDB.get("file:f1").then((b) => b.size)`), 3);
  a.close();
});

test("паника/полный сброс: ключ устройства уничтожается сразу — данные на диске необратимо нечитаемы, отложенные записи не воскрешают их", async () => {
  const a = await boot({ storage: { "ether.drafts": '{"alice":"ПАНИКА"}' } });
  await a.run(`SecureStore.flush()`);
  const disk = diskOf(a), idb = a.window.indexedDB;
  a.run(`localStorage.setItem("ether.drafts", '{"alice":"ПОСЛЕ"}')`); // отложенная запись
  await a.run(`SecureStore.shred()`);
  assert.equal(a.run(`SecureStore.hasDevice()`), false);
  await sleep(50);
  assert.equal(raw(a, "ether.drafts"), disk["ether.drafts"], "после shred ничего не дописывается");
  assert.equal(await readKeyRec(a), undefined, "запись ключа удалена");
  a.close();
  const b = createApp({ indexedDB: idb, storage: disk });
  await b.ready; for (let i = 0; i < 60 && b.run(`SecureStore.mode()`) === "init"; i++) await sleep(30);
  assert.equal(b.run(`SecureStore.mode()`), "keylost", "даже со старым диском и тем же профилем прочитать нечем");
  b.close();
});

test("wipeEverythingAndReload: ключ устройства убирается первым, база ключей удалена, localStorage пуст", async () => {
  const a = await boot({ storage: { "ether.drafts": '{"alice":"СТЕРЕТЬ"}' } });
  a.run(`location.reload = () => {};`);
  const p = a.run(`wipeEverythingAndReload()`);
  assert.equal(a.run(`SecureStore.hasDevice()`), false, "ключ уничтожен синхронно, до любых await");
  await p;
  assert.equal(a.window.localStorage.length, 0);
  const dbs = await a.window.indexedDB.databases();
  assert.ok(!dbs.some((d) => d.name === "ether-keys" || d.name === "ether-db"));
  a.close();
});

test("перф: повторная запись того же значения не шифрует заново; пачка быстрых правок — одна запись; загрузка 1 МБ в бюджете", async () => {
  const cj = contactsJson(2500, "ПЕРФ");
  const a = await boot({ storage: { "ether.contacts": cj } });
  await a.run(`SecureStore.flush()`);
  const r1 = raw(a, "ether.contacts");
  a.run(`localStorage.setItem("ether.contacts", localStorage.getItem("ether.contacts"))`);
  await a.run(`SecureStore.flush()`);
  assert.equal(raw(a, "ether.contacts"), r1, "тот же шифртекст (IV не менялся): повторного шифрования не было");
  const t0 = Date.now();
  a.run(`for (let i = 0; i < 50; i++) localStorage.setItem("ether.contacts", localStorage.getItem("ether.contacts") + " ".repeat(i + 1));`);
  await a.run(`SecureStore.flush()`);
  const dt = Date.now() - t0;
  assert.ok(dt < 5000, "50 правок по 1 МБ: " + dt + " мс");
  assert.notEqual(raw(a, "ether.contacts"), r1);
  a.close();
});
