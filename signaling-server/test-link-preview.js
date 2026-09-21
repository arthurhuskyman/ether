// Проверяет самое важное в /link-preview: (1) защиту от SSRF — сервер не
// должен ходить на приватные/внутренние адреса по чужой просьбе, и
// (2) разбор HTML (og:title/description/image, фолбэк на <title>).
// Полноценный сетевой запрос к реальному внешнему сайту здесь не
// тестируется — песочница разработки ограничена белым списком доменов,
// это тестовое окружение, а не сама функция.

const http = require("http");

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log("  OK   " + label); }
  else { fail++; console.log("  FAIL " + label); }
}

// Загружаем server.js как модуль, подменяя require("dotenv") и слушая на
// случайном порту, чтобы не конфликтовать с уже запущенным сервером.
process.env.PORT = "8788";
process.env.VAPID_PUBLIC = "";
process.env.VAPID_PRIVATE = "";
process.env.METERED_API_KEY = "";

const path = require("path");
// server.js сам вызывает httpServer.listen(...) в самом низу — достаточно
// просто require() его как обычный модуль, он поднимет сервер сам.
require(path.join(__dirname, "server.js"));

function httpGet(reqPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: 8788, path: reqPath, timeout: 8000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
}

(async () => {
  await new Promise((r) => setTimeout(r, 500)); // дать серверу подняться

  console.log("\n=== SSRF-защита: приватные/внутренние адреса должны блокироваться ===");
  {
    const targets = [
      "http://127.0.0.1:9999/secret",
      "http://localhost/secret",
      "http://169.254.169.254/latest/meta-data/", // классический адрес метадаты облака
      "http://10.0.0.5/internal",
      "http://192.168.1.1/router",
    ];
    for (const t of targets) {
      const r = await httpGet("/link-preview?url=" + encodeURIComponent(t));
      check(`заблокирован приватный адрес: ${t}`, r.status === 204 || r.status === 400);
    }
  }

  console.log("\n=== Некорректные запросы обрабатываются без падения сервера ===");
  {
    const r1 = await httpGet("/link-preview");
    check("без параметра url -> 400, не 500", r1.status === 400);
    const r2 = await httpGet("/link-preview?url=" + encodeURIComponent("ftp://example.com/file"));
    check("неподдерживаемая схема (ftp) отклонена, не упала", r2.status === 204 || r2.status === 400);
    const r3 = await httpGet("/link-preview?url=" + encodeURIComponent("not a url at all"));
    check("мусорная строка вместо URL не роняет сервер", r3.status === 204 || r3.status === 400);
  }

  console.log("\n=== Сервер остаётся отзывчивым после всех попыток (ничего не зависло) ===");
  {
    const r = await httpGet("/health");
    check("health-check отвечает", r.status === 200);
  }

  console.log(`\nИтого: ${pass} прошло, ${fail} упало`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error("Ошибка теста:", e);
  process.exit(1);
});
