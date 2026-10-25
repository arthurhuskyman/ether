// V.80: экспорт/импорт при шифровании по умолчанию, предупреждение об открытой копии, зеркало IndexedDB, ограничения пакета переезда
const test = require("node:test");
const assert = require("node:assert/strict");
const { closeAll } = require("./harness");
const { boot, raw, dumpRaw, diskOf, sleep } = require("./fix80-storage-helpers");
test.after(closeAll);

const seed = async (a) => {
  a.run(`const c = ensureContactEntry("alice", "Alice"); c.managed = true; c.messages.push({ id: "m1", from: "me", text: "ЭКСПОРТ-СЕКРЕТ", ts: Date.now(), ack: "sent" }); persistContacts(); persistContactsNow();`);
  await a.run(`SecureStore.flush()`);
};
const doExport = async (a, action, pw) => {
  a.run(`window.downloadBlob = (b, n) => { window.__dl = { name: n, blob: b }; }; window.__dl = null;`);
  const p = a.run(`exportBackup()`); await sleep(30);
  if (action === "confirm") { a.document.querySelector("#backup-password-input").value = pw; a.document.querySelector("#backup-password-confirm").click(); }
  else a.document.querySelector("#backup-password-skip").click();
  await p; return JSON.parse(await a.window.__dl.blob.text());
};

test("экспорт с паролем: файл зашифрован паролем (не ключом устройства), на новом устройстве импортируется и снова шифруется ЕГО ключом", async () => {
  const a = await boot(); await seed(a);
  const file = await doExport(a, "confirm", "pw-12345");
  assert.equal(file.etherEncryptedBackup, true);
  assert.ok(!JSON.stringify(file).includes("ЭКСПОРТ-СЕКРЕТ"));
  a.close();
  const b = await boot({ storage: { "ether.name": "", "ether.myId": "" } });
  const idbB = b.window.indexedDB;
  b.run(`window.confirmSheet = async () => true; location.reload = () => {};`);
  b.window.__f = { text: async () => JSON.stringify(file) };
  const ip = b.run(`importBackupFile(__f)`); await sleep(30);
  b.document.querySelector("#backup-password-input").value = "pw-12345"; b.document.querySelector("#backup-password-confirm").click();
  await ip;
  const disk = diskOf(b); b.close();
  assert.ok(disk["ether.contacts"].startsWith("encd1:"), "после импорта на диске шифртекст ключа этого устройства");
  assert.ok(!Object.values(disk).join("").includes("ЭКСПОРТ-СЕКРЕТ"));
  const c = await boot({ indexedDB: idbB, storage: disk });
  assert.match(c.window.localStorage.getItem("ether.contacts"), /ЭКСПОРТ-СЕКРЕТ/);
  c.close();
});

test("экспорт без пароля — явная открытая копия: предупреждение показано, файл содержит расшифрованные данные, соль/проверка PIN не экспортируются", async () => {
  const a = await boot(); await seed(a);
  await a.run(`SecureStore.enable("123456")`);
  a.run(`window.__toasts = []; toast = (m) => { window.__toasts.push(m); };`);
  const file = await doExport(a, "skip");
  assert.match(file["ether.contacts"], /ЭКСПОРТ-СЕКРЕТ/, "в явном открытом файле — данные читаемы (поэтому предупреждение)");
  assert.ok(!Object.keys(file).some((k) => k.startsWith("ether.sec.")), "соль/проверка PIN не утекают в копию");
  assert.ok(a.run(`window.__toasts`).some((m) => /НЕ\sзашифрована/.test(m)), "предупреждение об открытой копии");
  a.close();
});

test("импорт открытой копии при включённом PIN: слой PIN снимается, данные заменяются, на диске — шифртекст устройства, устаревшие записи кэша не остаются", async () => {
  const a = await boot({ storage: { "ether.drafts": '{"alice":"СТАРЫЙ-ЧЕРНОВИК"}' } });
  await a.run(`SecureStore.enable("123456")`);
  a.run(`window.confirmSheet = async () => true; location.reload = () => {};`);
  a.window.__f = { text: async () => JSON.stringify({ "ether.name": "Zed", "ether.myId": "zed", "ether.callLog": '[{"n":"ИМПОРТ"}]' }) };
  await a.run(`importBackupFile(__f)`);
  assert.equal(a.run(`SecureStore.isOn()`), false);
  assert.equal(a.window.localStorage.getItem("ether.drafts"), null, "ключ, которого нет в копии, не остался в кэше");
  assert.equal(a.window.localStorage.getItem("ether.callLog"), '[{"n":"ИМПОРТ"}]');
  assert.ok(raw(a, "ether.callLog").startsWith("encd1:"), "записано шифртекстом до перезагрузки (flush в applyImportedData)");
  assert.ok(!dumpRaw(a).includes("ИМПОРТ"));
  a.close();
});

test("зеркало IndexedDB (scheduleIDBBackup): восстановление после потери localStorage при сохранённом ключе устройства", async () => {
  const a = await boot(); await seed(a);
  await a.run(`backupToIDB()`);
  const idb = a.window.indexedDB; a.close();
  const b = await boot({ indexedDB: idb, storage: { "ether.name": "", "ether.myId": "" } }); // localStorage пуст, IDB и ключ целы
  await sleep(100);
  assert.equal(b.run(`SecureStore.mode()`), "device");
  assert.match(b.window.localStorage.getItem("ether.contacts") || "", /ЭКСПОРТ-СЕКРЕТ/, "контакты вернулись из зеркала (шифртекст) и открылись ключом устройства");
  b.close();
});
