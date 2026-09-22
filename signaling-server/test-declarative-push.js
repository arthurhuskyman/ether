// Проверяет форму payload'а, который уходит в web-push, против реальной
// схемы Declarative Web Push (W3C Push API, "3.3 Declarative push message"):
// https://www.w3.org/TR/push-api/#declarative-push-message
// Ошибка здесь тихо ломает нативную обработку на Safari/iOS — браузер
// просто не распознает пакет как декларативный и откатится на обычный
// путь (или вообще ничего не покажет), без явной ошибки где-либо.

process.env.PORT = "8790";
process.env.VAPID_PUBLIC = "";
process.env.VAPID_PRIVATE = "";
process.env.METERED_API_KEY = "";
process.env.ALLOWED_ORIGIN = "https://arthurhuskyman.github.io/ether";

const path = require("path");
require(path.join(__dirname, "server.js"));

// buildDeclarativePush не экспортирован — извлекаем его тем же приёмом,
// что и в других тестах этого набора (через строковый патч require).
const fs = require("fs");
const src = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const fnMatch = src.match(/function buildDeclarativePush\([\s\S]*?\n\}/);
if (!fnMatch) { console.error("не нашёл buildDeclarativePush в server.js"); process.exit(1); }
const APP_ORIGIN = "https://arthurhuskyman.github.io/ether";
// eslint-disable-next-line no-eval
const buildDeclarativePush = eval("(" + fnMatch[0].replace("function buildDeclarativePush", "function") + ")");

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log("  OK   " + label); }
  else { fail++; console.log("  FAIL " + label); }
}

console.log("\n=== Уведомление о звонке: обязательные поля спецификации на месте ===");
{
  const p = buildDeclarativePush({ title: "📞 Алиса", body: "Входящий вызов", tag: "ether-call-abc", contactId: "abc", kind: "call" });
  check("web_push === 8030 (иначе платформа не распознает пакет вообще)", p.web_push === 8030);
  check("notification — объект", typeof p.notification === "object" && p.notification !== null);
  check("notification.title — непустая строка (обязательное поле)", typeof p.notification.title === "string" && p.notification.title.length > 0);
  check("notification.navigate — обязательное поле, абсолютный URL", typeof p.notification.navigate === "string" && /^https:\/\//.test(p.notification.navigate));
  check("navigate указывает на настоящий origin приложения", p.notification.navigate.indexOf(APP_ORIGIN) === 0);
  check("navigate содержит contactId для маршрутизации после открытия", p.notification.navigate.indexOf("call=abc") !== -1);
  check("mutable === false (показ напрямую платформой, без ожидания Service Worker)", p.mutable === false);
  check("requireInteraction=true для звонка (не должно исчезнуть само)", p.notification.requireInteraction === true);
  check("vibrate — массив (для платформ, где кастомная вибрация поддерживается)", Array.isArray(p.notification.vibrate) && p.notification.vibrate.length > 0);
  check("icon/badge — абсолютные URL (относительные могут не резолвиться без окна)", /^https:\/\//.test(p.notification.icon) && /^https:\/\//.test(p.notification.badge));
  check("data.kind сохранён для notificationclick на браузерах без нативной поддержки", p.notification.data && p.notification.data.kind === "call");
}

console.log("\n=== Уведомление о сообщении: та же схема, другие детали ===");
{
  const p = buildDeclarativePush({ title: "Алиса", body: "Новое сообщение", tag: "ether-msg-abc", contactId: "abc", kind: "message" });
  check("web_push === 8030", p.web_push === 8030);
  check("navigate ведёт на ?chat=, не ?call=", p.notification.navigate.indexOf("chat=abc") !== -1);
  check("requireInteraction=false для обычного сообщения (не блокирует экран)", p.notification.requireInteraction === false);
  check("JSON.stringify не падает и результат снова парсится (то, что реально уйдёт в sendNotification)", (() => {
    try { const s = JSON.stringify(p); const back = JSON.parse(s); return back.web_push === 8030; }
    catch (e) { return false; }
  })());
}

console.log(`\nИтого: ${pass} прошло, ${fail} упало`);
process.exit(fail > 0 ? 1 : 0);
