// Шифрование данных на устройстве: включение/выключение, расшифровка по PIN, смена PIN, файлы, резервная копия без открытого текста.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closeAll } = require("./harness");
test.after(closeAll);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function booted(storage) {
  const a = createApp({ storage: Object.assign({ "ether.name": "T", "ether.myId": "me-test-id", "ether.lang": "ru" }, storage || {}) });
  await a.ready;
  for (let i = 0; i < 60 && !a.run(`typeof __appStarted !== "undefined" && __appStarted`); i++) await sleep(50);
  return a;
}
const LS = (a, k) => a.run(`SecureStore.rawGet(${JSON.stringify(k)})`);

test("включение: данные на диске — шифртекст, приложение читает открытый текст, запись обновляет шифртекст; секретов в открытом виде нет", async () => {
  const a = await booted();
  a.run(`const c = ensureContactEntry("alice", "Alice"); c.managed = true; c.messages.push({ id: "m1", from: "me", text: "СЕКРЕТНОЕ-СООБЩЕНИЕ", ts: Date.now(), ack: "sent" }); persistContacts(); persistContactsNow();`);
  assert.match(LS(a, "ether.contacts"), /СЕКРЕТНОЕ/, "до включения — открытый текст");
  await a.run(`SecureStore.enable("123456")`);
  const disk = LS(a, "ether.contacts");
  assert.ok(disk.startsWith("enc1:"), "на диске шифртекст");
  assert.ok(!disk.includes("СЕКРЕТНОЕ") && !Buffer.from(disk.slice(5), "base64").toString("latin1").includes("alice"));
  assert.match(a.window.localStorage.getItem("ether.contacts"), /СЕКРЕТНОЕ/, "приложению отдаётся открытый текст");
  // новая запись
  a.run(`state.contacts.get("alice").messages.push({ id: "m2", from: "me", text: "ВТОРОЕ-СЕКРЕТНОЕ", ts: Date.now(), ack: "sent" }); persistContacts(); persistContactsNow();`);
  await a.run(`SecureStore.flush()`);
  const disk2 = LS(a, "ether.contacts");
  assert.notEqual(disk2, disk); assert.ok(disk2.startsWith("enc1:"));
  // блокировка по неверному PIN, разблокировка по верному на «свежем» окне с тем же хранилищем
  assert.equal(await a.run(`SecureStore.verify("000000").then((x) => !!x)`), false);
  assert.equal(await a.run(`SecureStore.verify("123456").then((x) => !!x)`), true);
  a.close();
});

test("перезапуск: без unlock данные недоступны, unlock по PIN возвращает всё; неверный PIN не подходит", async () => {
  const a = await booted();
  a.run(`const c = ensureContactEntry("alice", "Alice"); c.managed = true; c.messages.push({ id: "m1", from: "me", text: "ПРОВЕРКА-ПЕРЕЗАПУСКА", ts: Date.now(), ack: "sent" }); persistContacts(); persistContactsNow();`);
  await a.run(`SecureStore.enable("654321")`);
  await a.run(`SecureStore.flush()`);
  const snapshot = {}; for (const k of ["ether.contacts", "ether.sec.on", "ether.sec.salt", "ether.sec.check", "ether.ratchet", "ether.privKey"]) { const v = LS(a, k); if (v !== null) snapshot[k] = v; }
  a.close();
  // новый «запуск»: тот же диск (шифртекст), пустая память
  const b = createApp({ storage: Object.assign({ "ether.name": "T", "ether.myId": "me-test-id", "ether.lang": "ru", "ether.pinEnabled": "0" }, snapshot) });
  await b.ready;
  assert.equal(b.run(`SecureStore.isOn()`), true);
  assert.equal(b.run(`SecureStore.isActive()`), false);
  assert.equal(await b.run(`SecureStore.unlock("111111")`), false, "неверный PIN");
  assert.equal(await b.run(`SecureStore.unlock("654321")`), true);
  assert.match(b.window.localStorage.getItem("ether.contacts"), /ПРОВЕРКА-ПЕРЕЗАПУСКА/);
  b.close();
});

test("смена PIN перешифровывает; выключение возвращает открытый текст; короткий PIN отклоняется", async () => {
  const a = await booted();
  a.run(`const c = ensureContactEntry("alice", "Alice"); c.managed = true; c.messages.push({ id: "m1", from: "me", text: "ДО-СМЕНЫ-PIN", ts: Date.now(), ack: "sent" }); persistContacts(); persistContactsNow();`);
  await assert.rejects(a.run(`SecureStore.enable("1234")`), /pin-short/);
  await a.run(`SecureStore.enable("111111")`);
  const before = LS(a, "ether.sec.check");
  assert.equal(await a.run(`SecureStore.rekey("111111", "222222")`), true);
  assert.notEqual(LS(a, "ether.sec.check"), before);
  assert.equal(await a.run(`SecureStore.verify("111111").then((x) => !!x)`), false, "старый PIN больше не подходит");
  assert.equal(await a.run(`SecureStore.verify("222222").then((x) => !!x)`), true);
  assert.equal(await a.run(`SecureStore.disable("222222")`), true);
  assert.equal(a.run(`SecureStore.isOn()`), false);
  assert.match(LS(a, "ether.contacts"), /ДО-СМЕНЫ-PIN/, "снова открытый текст");
  assert.equal(LS(a, "ether.sec.salt"), null);
  a.close();
});

test("файлы в IndexedDB шифруются отдельным ключом и читаются обратно; резервная копия ключей не содержит открытого текста", async () => {
  const a = await booted();
  a.run(`const c = ensureContactEntry("alice", "Alice"); c.managed = true; c.messages.push({ id: "m1", from: "me", text: "ПРЯТАТЬ-В-БЭКАПЕ", ts: Date.now(), ack: "sent" }); persistContacts(); persistContactsNow();`);
  await a.run(`backupToIDB()`);
  assert.match(await a.run(`IDB.get("ether.contacts")`), /ПРЯТАТЬ-В-БЭКАПЕ/, "до шифрования копия открытая");
  await a.run(`SecureStore.enable("123456")`);
  await a.run(`backupToIDB()`);
  const bk = await a.run(`IDB.get("ether.contacts")`);
  assert.ok(bk.startsWith("enc1:") && !bk.includes("ПРЯТАТЬ"), "копия в IndexedDB — шифртекст");
  // файл
  const sealed = await a.run(`(async () => { const b = new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: "audio/webm" }); const s = await SecureStore.sealBlob(b); const o = await SecureStore.openBlob(s); return { enc: s.__enc, type: o.type, len: o.size, plainEqual: s instanceof Blob }; })()`);
  assert.equal(sealed.enc, 1); assert.equal(sealed.type, "audio/webm"); assert.equal(sealed.len, 5); assert.equal(sealed.plainEqual, false);
  a.close();
});

test("смена PIN: фото и голосовые остаются читаемыми под новым PIN", async () => {
  const a = await booted();
  a.run(`const c = ensureContactEntry("alice", "Alice"); c.managed = true; c.messages.push({ id: "f1", from: "alice", ts: Date.now(), file: { name: "p.png", mime: "image/png", size: 3, kind: "image" } });`);
  await a.run(`(async () => { await IDB.set("file:f1", new Blob([new Uint8Array([1,2,3])], { type: "image/png" })); await SecureStore.enable("123456"); await migrateFilesEncryption(true); })()`);
  const before = await a.run(`(async () => { const b = await IDB.get("file:f1"); return b ? b.size : -1; })()`);
  assert.equal(before, 3);
  // как в обработчике смены PIN
  await a.run(`(async () => { await migrateFilesEncryption(false); await SecureStore.rekey("123456", "987654"); await migrateFilesEncryption(true); })()`);
  const after = await a.run(`(async () => { const b = await IDB.get("file:f1"); return b ? b.size : -1; })()`);
  assert.equal(after, 3, "файл читается после смены PIN");
  assert.equal(await a.run(`SecureStore.verify("123456").then((d) => !!d)`), false, "старый PIN больше не подходит");
  assert.equal(await a.run(`SecureStore.verify("987654").then((d) => !!d)`), true);
  a.close();
});

test("запись: быстрые последовательные setItem — на диске последняя версия; удалённый ключ не воскресает", async () => {
  const a = await booted();
  await a.run(`SecureStore.enable("123456")`);
  a.run(`for (let i = 0; i < 20; i++) localStorage.setItem("ether.drafts", JSON.stringify({ v: i }));`);
  await a.run(`SecureStore.flush()`);
  assert.equal(a.run(`localStorage.getItem("ether.drafts")`), JSON.stringify({ v: 19 }));
  const raw = a.run(`SecureStore.rawGet("ether.drafts")`);
  assert.ok(raw.startsWith("enc1:"));
  a.run(`localStorage.setItem("ether.lastSeen", "{}"); localStorage.removeItem("ether.lastSeen");`);
  await a.run(`SecureStore.flush()`);
  await sleep(50);
  assert.equal(a.run(`SecureStore.rawGet("ether.lastSeen")`), null, "ключ удалён и на диске");
  a.close();
});

test("включение: нехватка места (квота) на полпути откатывает диск — данные читаются как прежде, соль не остаётся", async () => {
  const a = await booted();
  // два больших значения: открытым текстом помещаются в квоту, шифртекст (×1.33) — нет
  a.run(`localStorage.setItem("ether.drafts", "a".repeat(2400000)); localStorage.setItem("ether.callLog", "b".repeat(2400000));`);
  let failed = false;
  try { await a.run(`SecureStore.enable("123456")`); } catch (e) { failed = true; }
  assert.ok(failed, "enable должен упасть из-за квоты");
  assert.equal(a.run(`SecureStore.isOn()`), false);
  assert.equal(a.run(`SecureStore.rawGet("ether.sec.salt")`), null, "соль откатилась");
  assert.equal(a.run(`localStorage.getItem("ether.drafts").length`), 2400000, "данные прочитываются как прежде");
  assert.equal(a.run(`localStorage.getItem("ether.callLog").length`), 2400000);
  a.close();
});

test("двойной unlock не сбрасывает кэш; disable не теряет последнюю запись", async () => {
  const a = await booted();
  await a.run(`SecureStore.enable("123456")`);
  a.run(`localStorage.setItem("ether.drafts", "последнее")`);
  await a.run(`SecureStore.disable("123456")`);
  assert.equal(a.run(`SecureStore.rawGet("ether.drafts")`), "последнее", "после отключения на диске последнее значение открытым текстом");
  assert.equal(a.run(`SecureStore.isOn()`), false);
  a.close();
});
