// Исправления AUDIT-V80: D1 (claim по серверам), D2/D3 (ratchet и groupkeys не копируются), D5 (groupkeys в SecureStore), D7 (приватные подсказки)
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { closeAll } = require("./harness");
const { boot, sleep } = require("./fix80-storage-helpers");
test.after(closeAll);

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

test("D1: у серверов вне доверенных proof свой (v2, привязан к origin), встроенному/введённому вручную — прежний v1; токен не уходит", async () => {
  const a = await boot();
  const t = a.run(`Store.claimToken`);
  a.run(`window.__res = {}; Promise.all([claimProofFor("wss://evil.example"), claimProofFor("wss://other.example:8443/x"), claimProofFor(DEFAULT_SIGNALING_URL)]).then((r) => { window.__res = r; })`);
  for (let i = 0; i < 40 && !a.window.__res[0]; i++) await sleep(25);
  const [evil, other, def] = a.window.__res;
  assert.equal(evil, sha("ether-claim-v2|" + t + "|https://evil.example"));
  assert.equal(other, sha("ether-claim-v2|" + t + "|https://other.example:8443"));
  assert.equal(def, sha("ether-claim-v1|" + t), "встроенный сервер: прежний proof (совместимость с уже закреплёнными id)");
  assert.notEqual(evil, def); assert.notEqual(evil, other);
  assert.ok(![evil, other, def].some((p) => p.includes(t)));
  assert.equal(a.run(`claimProofCachedFor("wss://evil.example")`), evil, "кэш после первого вычисления");
  assert.equal(a.run(`claimProofCachedFor("wss://never.example")`), null);
  // введённый вручную в поле «Сервер» сервер тоже получает прежний proof (там id уже закреплён)
  a.run(`localStorage.setItem("ether.signalingUrl", "wss://mine.example")`);
  assert.equal(a.run(`claimLegacyServer("wss://mine.example")`), true);
  assert.equal(a.run(`claimLegacyServer("wss://evil.example")`), false);
  a.close();
});

test("D7: подсказки серверов от контакта без IP-литералов и служебных имён (кроме loopback при allowLocal)", async () => {
  const a = await boot();
  const r = a.run(`JSON.stringify(ServerList.normalizeHints(["https://192.168.1.5", "https://10.0.0.2:8443", "https://printer.local", "https://nas.lan", "https://[::1]", "https://relay.example.org"], {}))`);
  assert.deepEqual(JSON.parse(r), ["wss://relay.example.org"]);
  const l = a.run(`JSON.stringify(ServerList.normalizeHints(["http://127.0.0.1:8080", "https://192.168.1.5"], { allowLocal: true }))`);
  assert.ok(JSON.parse(l).includes("ws://127.0.0.1:8080"));
  a.close();
});

test("D5: ether.groupkeys шифруется в покое (SecureStore.KEYS), прежнее открытое значение мигрирует", async () => {
  const a = await boot();
  assert.equal(a.run(`SecureStore.KEYS.includes("ether.groupkeys")`), true);
  a.run(`localStorage.setItem("ether.groupkeys", JSON.stringify({ v: 1, send: { g: { ck: "SECRET-CK" } } }))`);
  await a.run(`SecureStore.flush()`);
  const disk = a.run(`SecureStore.rawGet("ether.groupkeys")`);
  assert.ok(disk && !disk.includes("SECRET-CK"), "на диске шифртекст");
  assert.match(a.run(`localStorage.getItem("ether.groupkeys")`), /SECRET-CK/, "приложению значение доступно");
  a.close();
});

test("D2/D3: ether.ratchet и ether.groupkeys не попадают в файл копии, пакет переноса и пару-компаньон; из файла не восстанавливаются", async () => {
  const a = await boot();
  a.run(`localStorage.setItem("ether.ratchet", '{"s":{"x":1}}'); localStorage.setItem("ether.groupkeys", '{"v":1}'); localStorage.setItem("ether.name", "Anya");`);
  await a.run(`SecureStore.flush()`);
  // пакет переноса
  const pkg = a.run(`JSON.stringify(DeviceLink.collectData())`);
  assert.ok(!("ether.ratchet" in JSON.parse(pkg)) && !("ether.groupkeys" in JSON.parse(pkg)) && "ether.name" in JSON.parse(pkg));
  assert.ok(!a.run(`JSON.stringify(DeviceLink.sanitizeData({ "ether.ratchet": "x", "ether.groupkeys": "y", "ether.name": "n" }))`).match(/ratchet|groupkeys/));
  // companion
  assert.ok(!a.run(`JSON.stringify(Devices.companionData())`).match(/ether\.ratchet|ether\.groupkeys/));
  // файл копии
  a.run(`window.downloadBlob = (b, n) => { window.__dl = { name: n, blob: b }; };`);
  const p = a.run(`exportBackup()`); await sleep(30);
  a.document.querySelector("#backup-password-skip").click(); await p;
  const file = JSON.parse(await a.window.__dl.blob.text());
  assert.ok("ether.name" in file && !("ether.ratchet" in file) && !("ether.groupkeys" in file));
  // зеркало IDB не содержит ratchet (откат цепочки из устаревшего зеркала)
  assert.equal(a.run(`CRITICAL_LS_KEYS.includes("ether.ratchet")`), false);
  // импорт старого файла с ratchet: состояние не восстанавливается, остальное — да
  a.run(`window.confirmSheet = async () => true; location.reload = () => {};`);
  a.window.__f = { text: async () => JSON.stringify({ "ether.name": "Imp", "ether.ratchet": '{"s":{"old":1}}', "ether.groupkeys": '{"v":1,"old":1}' }) };
  await a.run(`importBackupFile(__f)`);
  assert.equal(a.run(`localStorage.getItem("ether.name")`), "Imp");
  assert.ok(!(a.run(`localStorage.getItem("ether.ratchet")`) || "").includes("old"));
  assert.ok(!(a.run(`localStorage.getItem("ether.groupkeys")`) || "").includes("old"));
  a.close();
});
