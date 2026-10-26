// Проверяет форму payload'а, который уходит в web-push, против реальной
// схемы Declarative Web Push (W3C Push API, "3.3 Declarative push message"):
// https://www.w3.org/TR/push-api/#declarative-push-message
// Ошибка здесь тихо ломает нативную обработку на Safari/iOS — браузер
// просто не распознает пакет как декларативный и откатится на обычный
// путь (или вообще ничего не покажет), без явной ошибки где-либо.

process.env.PORT = "8790";
process.env.VAPID_PUBLIC = "";
process.env.VAPID_PRIVATE = "";
// APP_BASE_URL — своя переменная именно для базового URL приложения
// (используется при формировании ссылок в push-уведомлениях). Раньше
// тест использовал ALLOWED_ORIGIN для этой же цели — technically
// работает (APP_BASE_URL получает ALLOWED_ORIGIN как fallback), но
// ALLOWED_ORIGIN нужен строго для CORS в виде голого origin, а здесь
// значение с путём (/ether). Если кто-то скопирует эту строку в
// реальное окружение, CORS сломается — путаница между двумя разными
// по смыслу переменными.
process.env.APP_BASE_URL = "https://arthurhuskyman.github.io/ether";

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

const hMatch = src.match(/function buildHybridRing\([\s\S]*?\n\}/);
if (!hMatch) { console.error("не нашёл buildHybridRing в server.js"); process.exit(1); }
// eslint-disable-next-line no-eval
const buildHybridRing = eval("(" + hMatch[0].replace("function buildHybridRing", "function") + ")");

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
  // V.80.1: сообщения mutable:true — живой SW применяет фильтр заблокированных, при мёртвом SW платформа показывает уведомление сама
  check("mutable === true для сообщения (V.80.1; раньше false)", p.mutable === true);
  check("silent === false и lang/dir заданы", p.notification.silent === false && p.notification.lang === "en" && p.notification.dir === "ltr");
  check("app_badge не шлётся (сервер не знает общего числа непрочитанных)", !("app_badge" in p.notification));
  check("RTL-язык даёт dir=rtl", buildDeclarativePush({ title: "x", kind: "message", contactId: "a" }, "ar-SA").notification.dir === "rtl");
  check("JSON.stringify не падает и результат снова парсится (то, что реально уйдёт в sendNotification)", (() => {
    try { const s = JSON.stringify(p); const back = JSON.parse(s); return back.web_push === 8030; }
    catch (e) { return false; }
  })());
}

console.log("\n=== Гибридный «гудок» (PUSH_RING_HYBRID / push-test-ring mode:hybrid) ===");
{
  const tx = (lang, k) => ({ call: "Call", incomingCall: "Incoming call", callEnded: "Call ended", callMissed: "Missed call" })[k];
  const r = buildHybridRing({ callId: "abc123", from: "bob", name: "Bob", seq: 2, total: 6, video: true, ackToken: "tok", lang: "ru-RU", appOrigin: APP_ORIGIN }, tx);
  const n = r.notification;
  check("web_push 8030 и mutable:true", r.web_push === 8030 && r.mutable === true);
  check("tag ring-<callId>, silent:false, lang ru", n.tag === "ring-abc123" && n.silent === false && n.lang === "ru");
  check("navigate — глубокая ссылка #answer=…&from=…", n.navigate === APP_ORIGIN + "/#answer=abc123&from=bob");
  check("data для SW: t, callId, seq, total, from, name, video, ackToken", n.data.t === "call-ring" && n.data.callId === "abc123" && n.data.seq === 2 && n.data.total === 6 && n.data.from === "bob" && n.data.name === "Bob" && n.data.video === true && n.data.ackToken === "tok");
  check("title содержит имя, body — «входящий»", n.title.indexOf("Bob") >= 0 && n.body === "Incoming call");
  const c = buildHybridRing({ cancel: true, reason: "cancelled", callId: "abc123", from: "bob", name: "Bob", lang: "en", appOrigin: APP_ORIGIN }, tx);
  check("cancel: тот же tag (заменяет гудок), data.t call-cancel, «пропущенный»", c.notification.tag === "ring-abc123" && c.notification.data.t === "call-cancel" && c.notification.title === "Missed call");
  const e = buildHybridRing({ cancel: true, reason: "answered", callId: "abc123", from: "bob", name: "Bob", lang: "en", appOrigin: APP_ORIGIN }, tx);
  check("cancel answered: «Call ended»", e.notification.title === "Call ended");
  check("JSON-сериализуемо", JSON.parse(JSON.stringify(r)).notification.data.t === "call-ring");
}

console.log(`\nИтого: ${pass} прошло, ${fail} упало`);
process.exit(fail > 0 ? 1 : 0);
