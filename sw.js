const CACHE_VERSION = "ether-shell-v239";
// В предзагрузке только ядро. css/skins/<id>.css и fonts/skins/*.woff2 подтягиваются по требованию (активный скин) и
// кладутся в кэш обработчиком fetch ниже (runtime-cache, stale-while-revalidate).
const SHELL_FILES = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./js/app-names.json",
  "./css/tokens.css",
  "./css/styles.css",
  "./css/skins.css",
  "./js/languages-meta.js",
  "./js/lang/en.js",
  "./js/i18n.js",
  "./js/emoji-data.js",
  "./js/app/01-core-store.js",
  "./js/app/02-state-util.js",
  "./js/app/03-audio-pin.js",
  "./js/app/04-onboarding-push.js",
  "./js/app/05-contacts-nav.js",
  "./js/app/06-thread.js",
  "./js/app/07-send-outbox.js",
  "./js/app/08-files-voice.js",
  "./js/app/09-groups.js",
  "./js/app/10-signaling.js",
  "./js/app/11-qr-sheets-translate.js",
  "./js/app/12-calls-search.js",
  "./js/app/13-settings-debug.js",
  "./js/app/14-backup-boot.js",
  "./js/skins.js",
  "./js/skins/cartoon.js",
  "./js/skins/comic.js",
  "./js/skins/watercolor.js",
  "./js/skins/neon.js",
  "./js/skins/steampunk.js",
  "./js/skins/gothic.js",
  "./js/skins/clay.js",
  "./js/skins/lego.js",
  "./js/skins/wood.js",
  "./js/skins/glass.js",
  "./js/skins/chalk.js",
  "./js/skins/newyear.js",
  "./js/skins/sakura.js",
  "./js/features.js",
  "./js/features2.js",
  "./js/easter.js",
  "./js/group-call.js",
  "./js/rooms.js",
  "./js/localai.js",
  "./js/devicecheck.js",
  "./js/devicecert.js",
  "./js/devicelink.js",
  "./js/devices.js",
  "./js/webrtc.js",
  "./js/file-limits.js",
  "./js/signaling-codec.js",
  "./js/signaling-client.js",
  "./js/discovery.js",
  "./js/crypto-helper.js",
  "./js/secure-store.js",
  "./js/icons.js",
  "./js/rich.js",
  "./js/stickers.js",
  "./js/ratchet.js",
  "./js/linkauth.js",
  "./js/crypto-worker.js",
  "./js/vendor/qrcode-generator.js",
  "./js/vendor/qrcode-generator-utf8.js",
  "./js/vendor/jsQR.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/logo-256.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png",
  "./fonts/InterVariable.woff2",
  "./sounds/ring-classic.mp3",
  "./sounds/ring-soft.mp3",
  "./sounds/ring-bell.mp3",
  "./sounds/msg.mp3",
  "./sounds/msg-chime.mp3",
  "./sounds/msg-pop.mp3",
  "./sounds/msg-bell.mp3",
  "./sounds/call-dialing.mp3",
  "./sounds/call-busy.mp3",
  "./sounds/call-noanswer.mp3"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      Promise.all(SHELL_FILES.map((url) => fetch(url, { cache: "reload" }).then((res) => { if (!res.ok) throw new Error("shell fetch failed: " + url + " " + res.status); return cache.put(url, res); })))
    )
  );
  // ВАЖНО: skipWaiting() убран. Новый SW ждёт в состоянии "waiting",
  // пока страница не пришлёт ему SKIP_WAITING. Это даёт контроль:
  // приложение сначала показывает баннер "Доступно обновление", и
  // только после клика пользователя активирует новый SW и перезагружается.
  // Без этого новый SW стартовал бы при каждой проверке обновлений и
  // оставлял страницу в рассинхроне (старый JS + новые ресурсы из кэша).
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      // M1: удаляем только старые кэши оболочки (ether-shell-*); transformers-cache (модели Whisper) и ether-meta переживают релизы
      Promise.all(keys.filter((k) => k.startsWith("ether-shell-") && k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

function pickManifestLang(acceptLanguageHeader, available) {
  if (!acceptLanguageHeader) return "en";
  const parts = acceptLanguageHeader.split(",").map((p) => p.trim().split(";")[0].toLowerCase());
  for (const tag of parts) {
    if (available[tag]) return tag;
    const base = tag.split("-")[0];
    if (available[base]) return base;
  }
  return "en";
}
async function handleManifestRequest(request) {
  try {
    const [manifestRes, namesRes] = await Promise.all([
      caches.match("./manifest.webmanifest").then((c) => c || fetch(request)),
      caches.match("./js/app-names.json").then((c) => c || fetch("./js/app-names.json")),
    ]);
    const manifest = await manifestRes.clone().json();
    const localized = await namesRes.json();
    const lang = pickManifestLang(request.headers.get("Accept-Language"), localized);
    const entry = localized[lang] || localized.en;
    if (entry) {
      manifest.short_name = entry.name;
      manifest.name = entry.tagline ? entry.name + " — " + entry.tagline : entry.name;
      manifest.description = entry.tagline || manifest.description;
      manifest.lang = lang;
    }
    return new Response(JSON.stringify(manifest), {
      headers: { "Content-Type": "application/manifest+json" },
    });
  } catch (e) {
    return caches.match("./manifest.webmanifest").then((c) => c || fetch(request));
  }
}

// M3: файлы оболочки пишет только install; фоновый cache.put из fetch не должен подменять код текущего (активного) кэша новым
let SHELL_PATHS = null;
function isShellPath(pathname) {
  if (!SHELL_PATHS) SHELL_PATHS = new Set(SHELL_FILES.map((f) => new URL(f, self.location.href).pathname));
  return SHELL_PATHS.has(pathname);
}
// M4: Range (audio/video, iOS Safari требует 206) — из кэшированного 200 нарезаем нужный диапазон
function rangeResponse(cached, rangeHeader) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader || "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return Promise.resolve(cached);
  return cached.arrayBuffer().then((buf) => {
    const size = buf.byteLength;
    let start, end;
    if (m[1] === "") { const n = parseInt(m[2], 10); start = Math.max(0, size - n); end = size - 1; }
    else { start = parseInt(m[1], 10); end = m[2] === "" ? size - 1 : Math.min(parseInt(m[2], 10), size - 1); }
    if (!(start <= end) || start >= size) return new Response(null, { status: 416, headers: { "Content-Range": "bytes */" + size } });
    const headers = new Headers();
    headers.set("Content-Type", cached.headers.get("Content-Type") || "application/octet-stream");
    headers.set("Content-Range", "bytes " + start + "-" + end + "/" + size);
    headers.set("Content-Length", String(end - start + 1));
    headers.set("Accept-Ranges", "bytes");
    return new Response(buf.slice(start, end + 1), { status: 206, statusText: "Partial Content", headers });
  });
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.endsWith("/manifest.webmanifest")) {
    event.respondWith(handleManifestRequest(event.request));
    return;
  }
  if (url.search) {
    if (event.request.mode === "navigate") {
      event.respondWith(
        caches.match("./index.html").then((cached) => cached || fetch(event.request))
      );
    }
    return;
  }
  const rangeHdr = event.request.headers.get("range");
  if (rangeHdr) {
    event.respondWith(
      caches.match(event.request, { ignoreSearch: true }).then((cached) => (cached && cached.status === 200 ? rangeResponse(cached, rangeHdr) : fetch(event.request)))
        .catch(() => fetch(event.request))
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200 && response.type === "basic" && !isShellPath(url.pathname)) {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

self.addEventListener("message", (event) => {
  const data = event.data || {};

  // НОВОЕ: страница просит активировать waiting-SW — приходит по клику
  // на баннер "Обновить". Без этого SW остался бы в waiting навсегда,
  // пока пользователь не закроет все вкладки домена.
  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }
  // Страница спрашивает, какая версия оболочки у активного SW (сверка с версией загруженного JS: расхождение = пользователь сидит на старом коде)
  if (data.type === "GET_VERSION") {
    try { if (event.source && event.source.postMessage) event.source.postMessage({ type: "sw-version", version: CACHE_VERSION }); } catch (e) {}
    return;
  }

  // Список заблокированных контактов — Web Push от них не должен показываться (сервер о блокировке не знает)
  if (data.type === "blocked-ids") {
    const ids = Array.isArray(data.ids) ? data.ids.filter((x) => typeof x === "string").slice(0, 2000) : [];
    event.waitUntil(caches.open("ether-meta").then((c) => c.put("./__blocked.json", new Response(JSON.stringify(ids), { headers: { "Content-Type": "application/json" } }))).catch(() => {}));
    return;
  }
  if (data.type !== "show-notification") return;
  const title = String(data.title || "Мессенджер").slice(0, 60);
  const body = String(data.body || "").slice(0, 200);
  const tag = String(data.tag || "ether");
  // P2.37 (урезанный вариант) — actions пришли уже локализованными из
  // app.js (там доступен T()); в Service Worker своего i18n нет.
  // Notification.actions — расширение, которое просто игнорируется там,
  // где не поддерживается (например, часть версий iOS Safari) — ничего
  // не ломает, кнопка молча не появляется.
  const actions = Array.isArray(data.actions) ? data.actions.slice(0, 2) : undefined;
  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag,
    badge: "./icons/icon-192.png",
    icon: "./icons/icon-192.png",
    data: { contactId: data.contactId || null, kind: data.kind || "message" },
    silent: !!data.silent,
    vibrate: data.kind === "call" ? [300, 150, 300, 150, 300] : [100, 50, 100],
    requireInteraction: data.kind === "call",
    actions,
  }));
});

self.addEventListener("push", (event) => {
  let raw = null;
  if (event.data) {
    try { raw = event.data.json(); } catch (e) { raw = null; }
  }
  let n = raw && raw.notification && typeof raw.notification === "object"
    ? raw.notification
    : (raw && typeof raw === "object" ? raw : null);
  if (!n) n = { title: "Мессенджер", body: "", tag: "ether", data: {} };
  const data = n.data || {};
  event.waitUntil(
    caches.open("ether-meta").then((c) => c.match("./__blocked.json")).then((r) => r ? r.json() : []).catch(() => []).then((blockedIds) => {
      if (data.contactId && blockedIds.indexOf(data.contactId) >= 0) return null; // заблокирован: ни звонка, ни сообщения
      return self.clients.matchAll({ type: "window", includeUncontrolled: true });
    }).then((clientList) => {
      if (!clientList) return;
      const hasVisibleClient = clientList.some((c) => c.visibilityState === "visible");
      if (hasVisibleClient) return;
      // P2.37 (урезанный вариант) — для настоящего web-push (сервер
      // сигналинга будит нас, пока вкладка не открыта) сервер не знает
      // язык интерфейса пользователя, поэтому если он сам не прислал
      // n.actions — используем нейтральный англ. текст "Reply" как
      // разумный фолбэк, а не оставляем кнопку без неё вовсе.
      const actions = Array.isArray(n.actions) ? n.actions.slice(0, 2)
        : (data.kind !== "call" && data.contactId ? [{ action: "reply", title: "Reply" }] : undefined);
      return self.registration.showNotification(n.title || "Мессенджер", {
        body: n.body || "",
        tag: n.tag || "ether",
        badge: "./icons/icon-192.png",
        icon: "./icons/icon-192.png",
        data: { contactId: data.contactId || null, kind: data.kind || "message", navigate: data.navigate || n.navigate || null },
        vibrate: n.vibrate || (data.kind === "call" ? [300, 150, 300, 150, 300] : [100, 50, 100]),
        requireInteraction: !!n.requireInteraction || data.kind === "call",
        renotify: !!n.renotify,
        actions,
      });
    })
  );
});

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) c.postMessage({ type: "push-subscription-changed" });
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const contactId = data.contactId;
  const kind = data.kind || "message";
  const navigateUrl = data.navigate || "./";
  // P2.37 (урезанный вариант) — клик по самой кнопке-действию "Ответить"
  // (event.action === "reply") помечаем флагом focusInput, который
  // app.js использует, чтобы поставить курсор сразу в поле ввода после
  // открытия чата — настоящего инлайн-ответа без открытия приложения
  // в Web Notification API нет, см. комментарий у showNotification().
  const focusInput = event.action === "reply";
  // "Прочитано" — не открывает чат и не ворует фокус у текущего окна
  // (пользователь мог и не собирался открывать приложение, просто
  // разгрузить список непрочитанных). Работает только если приложение
  // уже где-то открыто, хотя бы в фоне — помечать прочитанным без живой
  // страницы, которая держит state.contacts, негде (честно, не "почти
  // то же самое, но тихо не работает" — см. P2.37 выше по тому же duху).
  if (event.action === "mark-read") {
    event.waitUntil(
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
        for (const c of list) c.postMessage({ type: "mark-read", contactId });
      })
    );
    return;
  }
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) {
          c.postMessage({ type: "open-contact", contactId, kind, focusInput, ts: data.ts || null });
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(navigateUrl);
    })
  );
});