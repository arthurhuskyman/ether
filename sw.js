const CACHE_VERSION = "ether-shell-v127";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./js/app-names.json",
  "./css/styles.css",
  "./js/languages-meta.js",
  "./js/lang/en.js",
  "./js/i18n.js",
  "./js/app.js",
  "./js/webrtc.js",
  "./js/file-limits.js",
  "./js/signaling-codec.js",
  "./js/signaling-client.js",
  "./js/crypto-helper.js",
  "./js/vendor/qrcode-generator.js",
  "./js/vendor/qrcode-generator-utf8.js",
  "./js/vendor/jsQR.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png",
  "./fonts/InterVariable.woff2",
  "./sounds/ring-classic.mp3",
  "./sounds/msg.mp3",
  "./sounds/call-dialing.mp3",
  "./sounds/call-busy.mp3",
  "./sounds/call-noanswer.mp3"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      Promise.all(SHELL_FILES.map((url) => fetch(url, { cache: "reload" }).then((res) => cache.put(url, res))))
    )
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
  let raw = null;
  if (event.data) {
    try { raw = event.data.json(); } catch (e) { raw = null; }
  }
  let n = raw && raw.notification && typeof raw.notification === "object"
    ? raw.notification
    : (raw && typeof raw === "object" ? raw : null);
  if (!n) n = { title: "Эфир", body: "", tag: "ether", data: {} };
  const data = n.data || {};
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      const hasVisibleClient = clientList.some((c) => c.visibilityState === "visible");
      if (hasVisibleClient) return;
      return self.registration.showNotification(n.title || "Эфир", {
        body: n.body || "",
        tag: n.tag || "ether",
        badge: "./icons/icon-192.png",
        icon: "./icons/icon-192.png",
        data: { contactId: data.contactId || null, kind: data.kind || "message", navigate: data.navigate || n.navigate || null },
        vibrate: n.vibrate || (data.kind === "call" ? [300, 150, 300, 150, 300] : [100, 50, 100]),
        requireInteraction: !!n.requireInteraction || data.kind === "call",
        renotify: !!n.renotify,
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
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) {
          c.postMessage({ type: "open-contact", contactId, kind });
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(navigateUrl);
    })
  );
});