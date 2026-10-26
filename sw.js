const CACHE_VERSION = "ether-shell-v244";
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
  "./config.js",
  "./js/bundle.core.js",
  "./js/bundle.app.js",
  "./js/bundle.features.js",
  "./js/bundle.fx.js",
  // Исходники бандлов (js/i18n.js, js/app/*.js, js/skins/* …) не кэшируются: их заменяют js/bundle.*.js (tools/build-bundles.js).
  "./js/textscale.js",
  "./js/easter.js",
  "./js/crypto-helper.js",
  "./js/crypto-worker.js",
  "./js/vendor/qrcode-generator.js",
  "./js/vendor/qrcode-generator-utf8.js",
  "./js/vendor/jsQR.js",
  "./js/release-key.js",
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

// ---------- V.80: подписанные релизы (docs/RELEASING.md) ----------
// Ключ настроен (js/release-key.js: window.RELEASE_PUBKEY != null) -> новая версия ставится, только если подпись release-manifest.json верна
// и хэш каждого файла оболочки совпал; иначе install падает, остаётся старая версия и кэш, страница получает «update-rejected».
// Ключ не настроен -> поведение как раньше (ничего не проверяется). Ключ закрепляется при первой установке с ним (ether-meta/__relkey.json):
// следующая версия с другим ключом или без ключа отклоняется (смена ключа — только осознанным действием владельца, см. RELEASING.md).
function installShell(cache, policy) {
  const get = (url) => fetch(url, { cache: "reload" }).then((res) => { if (!res.ok) throw new Error("shell fetch failed: " + url + " " + res.status); return res; });
  if (!policy) return Promise.all(SHELL_FILES.map((url) => get(url).then((res) => cache.put(url, res))));
  return Promise.all(SHELL_FILES.map((url) => get(url).then((res) => policy.check(url, res.clone()).then(() => [url, res]))))
    .then((list) => Promise.all(list.map((x) => cache.put(x[0], x[1]))))
    .then(() => policy.commit());
}
function rejectRelease(why) { const e = new Error("release rejected: " + why); e.releaseRejected = true; return e; }
function notifyRejected(reason) {
  return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => { for (const c of list) { try { c.postMessage({ type: "update-rejected", reason: String(reason).slice(0, 200) }); } catch (e) {} } }).catch(() => {});
}
function relHex(buf) { return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join(""); }
function relB64u(str) { const t = String(str).replace(/-/g, "+").replace(/_/g, "/"), b = atob(t + "=".repeat((4 - (t.length % 4)) % 4)), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
function relValidKey(k) { return !!k && typeof k === "object" && k.kty === "EC" && k.crv === "P-256" && typeof k.x === "string" && typeof k.y === "string"; }
function relBundledKey() {
  try {
    if (typeof importScripts !== "function") return null;
    self.window = self; importScripts("./js/release-key.js");
    return relValidKey(self.RELEASE_PUBKEY) ? { kty: "EC", crv: "P-256", x: self.RELEASE_PUBKEY.x, y: self.RELEASE_PUBKEY.y } : null;
  } catch (e) { return null; }
}
function releasePolicy() {
  return metaGet("./__relkey.json").then((pinned) => {
    const bundled = relBundledKey();
    if (!bundled && !relValidKey(pinned)) return null; // подпись нигде не настроена — как раньше
    if (!bundled) throw rejectRelease("signing key removed");
    if (relValidKey(pinned) && (pinned.x !== bundled.x || pinned.y !== bundled.y)) throw rejectRelease("signing key changed");
    const jwk = bundled;
    return Promise.all([fetch("./release-manifest.json", { cache: "reload" }), fetch("./release-manifest.sig.json", { cache: "reload" })]).then((rs) => {
      if (!rs[0].ok || !rs[1].ok) throw rejectRelease("manifest or signature missing");
      return Promise.all([rs[0].arrayBuffer(), rs[1].json()]);
    }).then((mm) => crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"])
      .then((key) => crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, relB64u(mm[1] && mm[1].sig), mm[0]))
      .then((ok) => {
        if (!ok) throw rejectRelease("bad signature");
        const m = JSON.parse(new TextDecoder().decode(mm[0]));
        if (!m || m.v !== 1 || !m.files) throw rejectRelease("bad manifest");
        return {
          check: (url, res) => res.arrayBuffer().then((buf) => crypto.subtle.digest("SHA-256", buf)).then((d) => {
            const rel = new URL(url, self.location.href).pathname.replace(new URL("./", self.location.href).pathname, "") || "index.html";
            const name = rel;
            if (m.files[name] !== relHex(d)) throw rejectRelease("hash mismatch: " + name);
          }),
          commit: () => metaPut("./__relkey.json", jwk),
        };
      })); // сеть/WebCrypto упали -> install просто не удался (fail-closed, повтор позже), без ложного «не прошло подпись»
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    releasePolicy().then((policy) => caches.open(CACHE_VERSION).then((cache) => installShell(cache, policy)))
      .catch((e) => (e && e.releaseRejected ? notifyRejected(e.message).then(() => { throw e; }) : Promise.reject(e)))
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
  // V.79: настройки для push-звонков (HTTP-адрес сервера для push-ack и локализованные строки) — SW не видит localStorage/i18n
  if (data.type === "ring-config") {
    const cfg = { httpBase: typeof data.httpBase === "string" ? data.httpBase.slice(0, 300) : "", strings: {} };
    if (data.strings && typeof data.strings === "object") for (const k of ["ringTitle", "ringBody", "missed", "ended"]) if (typeof data.strings[k] === "string") cfg.strings[k] = data.strings[k].slice(0, 120);
    event.waitUntil(metaPut("./__ringcfg.json", cfg));
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

// ---------- V.79: серия «гудков» web-push (docs/CALL-RELIABILITY-PROTOCOL.md, A/B/C) ----------
const SIGNALING_FALLBACK_HTTP = "https://ether-1-baqy.onrender.com";
const RING_DEFAULT_STRINGS = { ringTitle: "📞 {name} звонит", ringBody: "Нажмите, чтобы ответить", missed: "Пропущенный звонок от {name}", ended: "Звонок завершён" };
function metaGet(name) { return caches.open("ether-meta").then((c) => c.match(name)).then((r) => (r ? r.json() : null)).catch(() => null); }
function metaPut(name, obj) { return caches.open("ether-meta").then((c) => c.put(name, new Response(JSON.stringify(obj), { headers: { "Content-Type": "application/json" } }))).catch(() => {}); }
function ringFill(tpl, name) { return String(tpl).replace("{name}", name); }
function ringDeepLink(callId, from) {
  let base = "/";
  try { base = new URL(self.registration.scope).pathname; } catch (e) {}
  return base + "#answer=" + encodeURIComponent(callId) + "&from=" + encodeURIComponent(from);
}
function hasVisibleWindow() {
  return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => list.some((c) => c.visibilityState === "visible")).catch(() => false);
}
function closeCallNotifications(callId) {
  return self.registration.getNotifications().then((list) => {
    const gone = [];
    for (const n of list) {
      const d = n.data || {};
      if (d.callId === callId || n.tag === "ring-" + callId) { gone.push({ name: d.name || "", from: d.from || "", ring: n.tag === "ring-" + callId || d.ring === true }); try { n.close(); } catch (e) {} }
    }
    return gone;
  }).catch(() => []);
}
function handleCallPush(raw) {
  const callId = String(raw.callId || "").slice(0, 80);
  if (!callId) return Promise.resolve();
  return Promise.all([metaGet("./__ringcfg.json"), metaGet("./__blocked.json"), metaPut("./__lastpush.json", { ts: Date.now(), t: raw.t, callId })]).then(([cfg, blocked]) => {
    cfg = cfg || {};
    const str = Object.assign({}, RING_DEFAULT_STRINGS, cfg.strings || {});
    const from = String(raw.from || "").slice(0, 200);
    if (from && Array.isArray(blocked) && blocked.indexOf(from) >= 0) return null; // заблокирован: ни звонка, ни пропущенного
    const nameOf = (n) => String(n || raw.name || "").slice(0, 60) || (from ? from.slice(0, 8) : "?");
    if (raw.t === "call-ring") {
      // push-ack — fire-and-forget (не блокирует показ), keepalive переживает закрытие SW
      let ack = Promise.resolve();
      if (typeof raw.ackToken === "string" && raw.ackToken) {
        const base = String(cfg.httpBase || SIGNALING_FALLBACK_HTTP).replace(/\/+$/, "");
        try { ack = Promise.resolve(fetch(base + "/push-ack", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callId, seq: raw.seq, ackToken: raw.ackToken }), keepalive: true })).catch(() => {}); } catch (e) { ack = Promise.resolve(); }
      }
      const name = nameOf();
      const show = closeCallNotifications(callId).then(() => hasVisibleWindow()).then((visible) => {
        if (visible) return; // приложение открыто и видно: звонок придёт по сокету
        return self.registration.showNotification(ringFill(str.ringTitle, name), {
          body: str.ringBody, tag: "ring-" + callId, badge: "./icons/icon-192.png", icon: "./icons/icon-192.png",
          data: { callId, from, name, kind: "call", ring: true, video: !!raw.video, url: ringDeepLink(callId, from), ts: Date.now() },
          vibrate: [300, 150, 300, 150, 300], requireInteraction: true,
        });
      });
      // открытым окнам сообщаем, что гудок дошёл (экран «Проверка уведомлений» ждёт именно этого)
      const notify = self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => { for (const c of list) { try { c.postMessage({ type: "ring-received", callId, seq: raw.seq, ts: Date.now() }); } catch (e) {} } }).catch(() => {});
      return Promise.all([show, ack, notify]);
    }
    if (raw.t === "call-cancel") {
      const reason = String(raw.reason || "");
      return closeCallNotifications(callId).then((gone) => hasVisibleWindow().then((visible) => {
        if (visible) return;
        const info = gone.find((g) => g.name) || gone[0] || {};
        const name = nameOf(info.name);
        const fromId = from || info.from || "";
        if (reason === "cancelled" || reason === "timeout") {
          return self.registration.showNotification(ringFill(str.missed, name), {
            tag: "missed-" + callId, badge: "./icons/icon-192.png", icon: "./icons/icon-192.png",
            data: { callId, contactId: fromId || null, from: fromId, name, kind: "missed-call" },
          });
        }
        return self.registration.showNotification(str.ended, {
          tag: "ended-" + callId, badge: "./icons/icon-192.png", icon: "./icons/icon-192.png", silent: true,
          data: { callId, contactId: null, from: fromId, name, kind: "call-ended" },
        });
      }));
    }
  });
}

self.addEventListener("push", (event) => {
  let raw = null;
  if (event.data) {
    try { raw = event.data.json(); } catch (e) { raw = null; }
  }
  if (raw && (raw.t === "call-ring" || raw.t === "call-cancel")) { event.waitUntil(handleCallPush(raw)); return; }
  // V.80.1: гибридный «гудок» — декларативный payload (mutable:true), данные звонка в notification.data: та же обработка, что у raw
  const hd = raw && raw.notification && typeof raw.notification === "object" && raw.notification.data;
  if (hd && (hd.t === "call-ring" || hd.t === "call-cancel")) { event.waitUntil(handleCallPush(Object.assign({}, hd))); return; }
  event.waitUntil(metaPut("./__lastpush.json", { ts: Date.now(), t: "push" })); // для экрана «Проверка уведомлений»
  let n = raw && raw.notification && typeof raw.notification === "object"
    ? raw.notification
    : (raw && typeof raw === "object" ? raw : null);
  if (!n) n = { title: "Мессенджер", body: "", tag: "ether", data: {} };
  const data = n.data || {};
  event.waitUntil(
    caches.open("ether-meta").then((c) => c.match("./__blocked.json")).then((r) => r ? r.json() : []).catch(() => []).then((blockedIds) => {
      if (data.contactId && blockedIds.indexOf(data.contactId) >= 0) { // заблокирован: ни звонка, ни сообщения
        // declarative+mutable:true: платформа покажет уведомление сама, если SW его не показал; закрыть можно только event.notification (если есть)
        try { if (event.notification && event.notification.close) event.notification.close(); } catch (e) {}
        return null;
      }
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

// D6: содержимое push формирует ретранслятор (возможно, чужой): в openWindow попадает только адрес того же origin, иначе "./"
function safeSameOriginUrl(u) {
  try {
    if (typeof u !== "string" || !u || u.length > 2000) return "./";
    const url = new URL(u, self.registration.scope);
    return url.origin === self.location.origin && (url.protocol === "https:" || url.protocol === "http:") ? u : "./";
  } catch (e) { return "./"; }
}
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const contactId = data.contactId;
  const kind = data.kind || "message";
  const navigateUrl = safeSameOriginUrl(data.navigate);
  // V.79: уведомление-«гудок»: окно есть — фокус + сообщение с глубокой ссылкой, нет — открываем /#answer=<callId>&from=<id>
  if (data.ring === true && data.callId) {
    event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) {
          c.postMessage({ type: "answer-call", callId: data.callId, from: data.from || "", name: data.name || "", url: data.url || "", video: !!data.video });
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(safeSameOriginUrl(data.url));
    }));
    return;
  }
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