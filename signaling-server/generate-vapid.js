// Генератор VAPID-ключей. Запускается один раз:
//   npm run generate-vapid
// Вывод копируется в переменные окружения сервера.

const webpush = require("web-push");

const keys = webpush.generateVAPIDKeys();

console.log("");
console.log("=== VAPID-ключи для Эфир ===");
console.log("");
console.log("Скопируйте в переменные окружения сервера:");
console.log("");
console.log("VAPID_PUBLIC=" + keys.publicKey);
console.log("VAPID_PRIVATE=" + keys.privateKey);
console.log("");
console.log("На Render: Dashboard → Environment → Add Environment Variable");
console.log("На Railway: Variables → New Variable");
console.log("");
console.log("Публичный ключ можно показывать клиентам. Приватный — только на сервере.");
console.log("");