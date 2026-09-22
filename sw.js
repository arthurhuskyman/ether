const CACHE_VERSION = "ether-shell-v36";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/styles.css",
  "./js/languages.js",
  "./js/i18n.js",
  "./js/app.js",
  "./js/webrtc.js",
  "./js/signaling-codec.js",
  "./js/signaling-client.js",
  "./js/crypto-helper.js",
  "./js/vendor/qrcode-generator.js",
  "./js/vendor/qrcode-generator-utf8.js",
  "./js/vendor/jsQR.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "./sounds/ring-classic.mp3",
  "./sounds/ring-soft.mp3",
  "./sounds/ring-bell.mp3",
  "./sounds/msg-icq-style.mp3",
  "./sounds/call-dialing.mp3",
  "./sounds/call-busy.mp3",
  "./sounds/call-noanswer.mp3"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;
  if (url.search) {
    // Навигационные запросы с query-строкой (например ?call=... или
    // ?chat=... — так открывается декларативное push-уведомление) должны
    // получить закешированную оболочку приложения, а не уйти мимо кеша:
    // офлайн-клик по такому уведомлению иначе открывал бы пустую
    // страницу. Сами query-параметры разбирает уже JS приложения после
    // загрузки (см. handleNotificationNavigateParams в app.js) — для
    // Service Worker это не имеет значения, какая версия index.html
    // отдана, лишь бы отдана была.
    if (event.request.mode === "navigate") {
      event.respondWith(
        caches.match("./index.html").then((cached) => cached || fetch(event.request))
      );
    }
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200 && response.type === "basic") {
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
  if (data.type !== "show-notification") return;
  const title = String(data.title || "Эфир").slice(0, 60);
  const body = String(data.body || "").slice(0, 200);
  const tag = String(data.tag || "ether");
  self.registration.showNotification(title, {
    body,
    tag,
    badge: "./icons/icon-192.png",
    icon: "./icons/icon-192.png",
    data: { contactId: data.contactId || null, kind: data.kind || "message" },
    silent: !!data.silent,
    vibrate: data.kind === "call" ? [300, 150, 300, 150, 300] : [100, 50, 100],
    requireInteraction: data.kind === "call",
  });
});

self.addEventListener("push", (event) => {
  // Formats Declarative Web Push (web_push: 8030) — на браузерах, которые
  // ещё не умеют показывать такие уведомления сами (не Safari), payload
  // долетает сюда как обычно, и мы вручную вызываем showNotification() с
  // теми же полями, что были бы использованы платформой нативно.
  let raw = null;
  if (event.data) {
    try { raw = event.data.json(); } catch (e) { raw = null; }
  }
  let n = raw && raw.web_push === 8030 && raw.notification ? raw.notification : null;
  if (!n) {
    // На случай payload в старом плоском формате или совсем без данных —
    // не роняем показ уведомления, показываем то, что есть.
    n = { title: "Эфир", body: "", tag: "ether", data: {} };
    if (raw && typeof raw === "object") Object.assign(n, raw);
  }
  const data = n.data || {};
  event.waitUntil(
    self.registration.showNotification(n.title || "Эфир", {
      body: n.body || "",
      tag: n.tag || "ether",
      badge: "./icons/icon-192.png",
      icon: "./icons/icon-192.png",
      data: { contactId: data.contactId || null, kind: data.kind || "message", navigate: data.navigate || n.navigate || null },
      vibrate: n.vibrate || (data.kind === "call" ? [300, 150, 300, 150, 300] : [100, 50, 100]),
      requireInteraction: !!n.requireInteraction || data.kind === "call",
      renotify: !!n.renotify,
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
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) {
          c.postMessage({ type: "open-contact", contactId, kind });
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow("./");
    })
  );
});