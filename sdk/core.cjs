"use strict";
// Загрузка криптографии приложения из js/ БЕЗ копирования логики: ratchet.js, groupkeys.js, channels.js, crypto-helper.js — те же файлы, что собираются в бандлы клиента.
// Ищем сначала sdk/js/ (его кладёт `npm run prepack` при публикации пакета), затем ../js/ (рабочая копия репозитория).
const fs = require("fs");
const path = require("path");
if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = require("crypto").webcrypto;
const DIR = [path.join(__dirname, "js"), path.join(__dirname, "..", "js")].find((d) => fs.existsSync(path.join(d, "ratchet.js")));
if (!DIR) throw new Error("ether-sdk: js/ratchet.js not found (run from the repository or `npm run prepack`)");
const src = (f) => fs.readFileSync(path.join(DIR, f), "utf8");
require(path.join(DIR, "vendor", "ml-kem768.js")); // globalThis.EtherMlKem768 (вшитая реализация ML-KEM-768; нативный WebCrypto используется, если он есть)
// Модули хранят состояние в замыкании, поэтому каждому Client нужен СВОЙ экземпляр (иначе два бота в одном процессе делили бы сессии).
function instance(file) { const m = { exports: {} }; new Function("module", "require", src(file))(m, require); return m.exports; }
const CryptoHelper = new Function(src("crypto-helper.js") + "\nreturn CryptoHelper;")();
module.exports = { instance, CryptoHelper, jsDir: DIR };
