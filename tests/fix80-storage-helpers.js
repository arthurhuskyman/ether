// Общие помощники тестов хранилища V.80 (шифрование в покое по умолчанию, ключ устройства)
const { createApp } = require("./harness");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = { "ether.name": "T", "ether.myId": "me-test-id", "ether.lang": "ru" };
// Окно + ожидание, пока SecureStore.init() отработает (режим перестаёт быть "init")
async function boot(opts = {}) {
  const a = createApp({ ...opts, storage: Object.assign({}, BASE, opts.storage || {}) });
  await a.ready;
  for (let i = 0; i < 100 && a.run(`SecureStore.mode()`) === "init"; i++) await sleep(30);
  for (let i = 0; i < 60 && a.run(`SecureStore.mode()`) !== "keylost" && !a.run(`typeof __appStarted !== "undefined" && __appStarted`); i++) await sleep(50);
  return a;
}
const raw = (a, k) => a.run(`SecureStore.rawGet(${JSON.stringify(k)})`);
// Все «сырые» значения localStorage одной строкой (то, что увидит читающий файлы хранилища)
const dumpRaw = (a) => { const o = []; const n = a.window.localStorage.length; for (let i = 0; i < n; i++) { const k = a.window.localStorage.key(i); o.push(k + "=" + raw(a, k)); } return o.join("\n"); };
// Снимок «диска» localStorage (сырые значения) для «перезапуска» в новом окне
const diskOf = (a) => { const m = {}; const n = a.window.localStorage.length; for (let i = 0; i < n; i++) { const k = a.window.localStorage.key(i); m[k] = raw(a, k); } return m; };
function contactsJson(n, marker) {
  const msgs = []; for (let i = 0; i < n; i++) msgs.push({ id: "m" + i, from: i % 2 ? "me" : "alice", text: marker + " сообщение номер " + i + " " + "x".repeat(300), ts: 1700000000000 + i, ack: "sent" });
  return JSON.stringify([{ id: "alice", name: "Alice", managed: true, messages: msgs }]);
}
module.exports = { boot, raw, dumpRaw, diskOf, contactsJson, sleep, createApp };
