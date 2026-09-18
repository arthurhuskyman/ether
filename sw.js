// Service worker — кеширует оболочку и показывает уведомления.
// Показ через SW, потому что new Notification() на iOS Safari не работает.

const CACHE_VERSION = "ether-shell-v13";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/styles.css",
  "./js/app.js",
  "./js/webrtc.js",
  "./js/signaling-codec.js",
  "./js/signaling-client.js",
  "./js/crypto-helper.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;
  if (url.search) return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request).then((response) => {
        if (response && response.status === 200 && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy));
        }
        return response;
      }).catch(() => cached);
      return cached || network;
    })
  );
});

// Показ уведомления по запросу из страницы. Работает там, где
// new Notification() молча ничего не делает — то есть на iOS Safari.
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
    silent: false,
  });
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const contactId = event.notification.data && event.notification.data.contactId;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) {
          c.postMessage({ type: "open-contact", contactId });
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow("./");
    })
  );
});