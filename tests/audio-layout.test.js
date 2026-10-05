// Звук звонка (эхо при переходе в видео, слайдер громкости, динамик/наушник) и вёрстка на iPhone.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { bootApp, closeAll, ROOT } = require("./harness");
test.after(closeAll);
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function fakeLink(a, id = "alice") {
  a.run(`ensureContactEntry("${id}", "Alice");`);
  a.run(`(() => { const l = new EventTarget(); Object.assign(l, { id: "${id}", status: "connected", localVideoTrack: null, startCall: async () => { l.status = "in-call"; }, endCall() {}, setMuted() {}, send: () => true, setRemoteVolume() {} }); mesh.links.set("${id}", l); })()`);
}
function stream(a, withVideo) {
  const mk = (kind) => { const t = new a.window.EventTarget(); Object.assign(t, { kind, readyState: "live", muted: false }); return t; };
  const audio = mk("audio"), video = withVideo ? mk("video") : null;
  return { audio, video, stream: { id: "S1", getVideoTracks: () => (video ? [video] : []), getAudioTracks: () => [audio], getTracks: () => [audio, video].filter(Boolean) } };
}
function deliver(a, st, track) { a.window.__st = st; a.window.__tr = track; a.run(`mesh.dispatchEvent(new CustomEvent("remote-track", { detail: { id: "alice", stream: window.__st, track: window.__tr } }))`); }
async function inCall(platform, extra = {}) {
  const a = await bootApp({ platform, ...extra });
  fakeLink(a);
  await a.run(`beginCall("alice", false)`);
  a.run(`setCallPhaseActive()`);
  return a;
}

for (const platform of ["desktop", "ios", "android"]) {
  test(`[${platform}] ЭХО: звук собеседника идёт только через один <audio>, <video> заглушён`, async () => {
    const a = await inCall(platform);
    const s = stream(a, true);
    deliver(a, s.stream, s.audio);   // сначала аудиотрек
    deliver(a, s.stream, s.video);   // потом (переход в видео) — видеотрек того же потока
    const rv = a.document.querySelector("#call-remote-video");
    assert.equal(rv.muted, true, "видеоэлемент не должен проигрывать звук потока второй раз");
    assert.ok(rv.hasAttribute("muted"));
    assert.equal(a.document.querySelectorAll("audio[id^=remote-audio-]").length, 1, "ровно один аудиоэлемент на собеседника");
    const sources = a.window.__audioNodes.filter((n) => n.type === "source");
    assert.equal(sources.length, 1, "цепочка Web Audio не пересобирается на видеотреке того же потока");
    a.close();
  });

  test(`[${platform}] ЭХО: локальное превью заглушено, чтобы не слышать самого себя`, async () => {
    const a = await bootApp({ platform });
    assert.ok(a.document.querySelector("#call-local-video").hasAttribute("muted"));
    a.close();
  });

  test(`[${platform}] слайдер громкости меняет громкость собеседника (GainNode), в том числе когда element.volume не работает`, async () => {
    const a = await inCall(platform);
    const s = stream(a, false); deliver(a, s.stream, s.audio);
    const audioEl = a.document.querySelector("audio[id^=remote-audio-]");
    // iOS: element.volume read-only
    if (platform === "ios") Object.defineProperty(audioEl, "volume", { get: () => 1, set: () => {}, configurable: true });
    const gain = audioEl._relayGain;
    assert.ok(gain, "в цепочке должен быть GainNode");
    const slider = a.document.querySelector("#call-volume-slider");
    slider.value = "0.25"; slider.dispatchEvent(new a.window.Event("input", { bubbles: true }));
    assert.equal(gain.gain.value, 0.25);
    assert.equal(a.run(`Store.callVolume`), 0.25);
    slider.value = "0"; slider.dispatchEvent(new a.window.Event("input", { bubbles: true }));
    assert.equal(gain.gain.value, 0);
    assert.equal(audioEl.volume === 1 || platform !== "ios", true);
    a.close();
  });

  test(`[${platform}] громкость применяется к новому звонку, link.setRemoteVolume не ломает gain`, async () => {
    const a = await inCall(platform);
    a.run(`Store.callVolume = 0.4;`);
    const s = stream(a, false); deliver(a, s.stream, s.audio);
    assert.equal(a.document.querySelector("audio[id^=remote-audio-]")._relayGain.gain.value, 0.4);
    a.close();
  });
}

test("громкость без Web Audio: слайдер управляет element.volume", async () => {
  const a = await inCall("android", { noAudioContext: true });
  const s = stream(a, false); deliver(a, s.stream, s.audio);
  const slider = a.document.querySelector("#call-volume-slider");
  slider.value = "0.3"; slider.dispatchEvent(new a.window.Event("input", { bubbles: true }));
  assert.equal(a.document.querySelector("audio[id^=remote-audio-]").volume, 0.3);
  a.close();
});

test("iOS: AudioContext в состоянии suspended возобновляется при подключении звука", async () => {
  const a = await inCall("ios", { suspendedAudio: true });
  const s = stream(a, false); deliver(a, s.stream, s.audio);
  assert.ok(a.window.__audioCtx.resumed >= 1);
  a.close();
});

test("[iOS] динамик/наушник через Audio Session API", async () => {
  const a = await inCall("ios");
  a.window.navigator.audioSession = { type: "auto" };
  const btn = a.document.querySelector("#call-speaker-btn");
  btn.click(); await tick(30);
  assert.equal(a.window.navigator.audioSession.type, "playback");
  assert.ok(btn.classList.contains("active"));
  btn.click(); await tick(30);
  assert.equal(a.window.navigator.audioSession.type, "play-and-record");
  assert.ok(!btn.classList.contains("active"));
  a.run(`closeCallScreen("completed")`);
  assert.equal(a.window.navigator.audioSession.type, "auto", "после звонка маршрут возвращается к авто");
  a.close();
});

test("[Android/desktop] динамик/наушник через setSinkId по устройствам вывода", async () => {
  const a = await inCall("android");
  const s = stream(a, false); deliver(a, s.stream, s.audio);
  const audioEl = a.document.querySelector("audio[id^=remote-audio-]");
  const sinks = [];
  audioEl.setSinkId = async (id) => { sinks.push(id); };
  a.window.navigator.mediaDevices.enumerateDevices = async () => [
    { kind: "audiooutput", label: "Speaker", deviceId: "spk" }, { kind: "audiooutput", label: "Earpiece", deviceId: "ear" } ];
  const btn = a.document.querySelector("#call-speaker-btn");
  btn.click(); await tick(40);
  btn.click(); await tick(40);
  assert.deepEqual(sinks, ["spk", "ear"]);
  a.close();
});

test("динамик: без setSinkId и без Audio Session — честный тост, состояние не меняется", async () => {
  const a = await inCall("android");
  const s = stream(a, false); deliver(a, s.stream, s.audio);
  a.document.querySelector("#call-speaker-btn").click(); await tick(20);
  assert.ok(!a.document.querySelector("#call-speaker-btn").classList.contains("active"));
  assert.ok(a.document.querySelector("#toast").textContent.length > 0);
  a.close();
});

// ---------- iPhone: вёрстка и футер ----------
const css = fs.readFileSync(path.join(ROOT, "css/styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const rule = (sel) => { const m = css.match(new RegExp("(^|\\n)" + sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}")); return m ? m[2] : ""; };

test("[iPhone] viewport запрещает масштабирование, чтобы страница не 'уезжала' после фокуса на поле", () => {
  const vp = html.match(/<meta name="viewport" content="([^"]+)"/)[1];
  assert.match(vp, /maximum-scale=1/);
  assert.match(vp, /user-scalable=no/);
  assert.match(vp, /viewport-fit=cover/);
});

test("[iPhone] высота оболочки не завязана на 100dvh (body fixed+inset:0, #app-shell 100%)", () => {
  assert.doesNotMatch(rule("body"), /100dvh/);
  assert.match(rule("body"), /position:\s*fixed;\s*inset:\s*0/);
  assert.doesNotMatch(rule("html"), /100dvh/);
  assert.match(rule("#app-shell"), /height:\s*100%/);
  assert.doesNotMatch(rule("#app-shell"), /100dvh/);
});

test("[iPhone] поля ввода на iOS не мельче 16px (иначе Safari зумит страницу при фокусе)", () => {
  assert.match(css, /@supports \(-webkit-touch-callout: none\)\s*\{\s*input, textarea, select \{ font-size: max\(16px, 1em\); \}/);
});

test("[iPhone] таб-бар учитывает safe-area-inset-bottom", () => {
  assert.match(rule("#tab-bar"), /env\(safe-area-inset-bottom/);
});

async function kbEnv(extra = {}) {
  const a = await bootApp({ platform: "ios", standalone: true, ...extra });
  const vv = new a.window.EventTarget();
  Object.assign(vv, { height: 800, offsetTop: 0 });
  Object.defineProperty(a.window, "visualViewport", { value: vv, configurable: true });
  Object.defineProperty(a.window, "innerHeight", { value: 800, configurable: true });
  Object.defineProperty(a.window, "scrollY", { value: 0, configurable: true, writable: true });
  a.run(`wireKeyboardFix()`);
  return { a, vv, shell: a.document.querySelector("#app-shell"), fire: () => vv.dispatchEvent(new a.window.Event("resize")) };
}

test("[iPhone] клавиатура открыта: оболочка привязана к видимой области (шапка на месте), поле ввода не двигается transform'ом", async () => {
  const { a, vv, shell, fire } = await kbEnv();
  a.run(`state.chatId = "alice"; ensureContactEntry("alice","Alice"); renderTab();`);
  vv.height = 480; vv.offsetTop = 120; fire();
  assert.equal(shell.style.height, "480px");
  assert.equal(shell.style.transform, "translateY(120px)");
  assert.ok(a.document.documentElement.classList.contains("kb-open"));
  assert.equal(a.document.querySelector(".chat-input-bar").style.transform, "", "поле ввода больше не прыгает");
  a.close();
});

test("[iPhone] клавиатура закрылась: всё возвращается, страница прокручена в 0", async () => {
  const { a, vv, shell, fire } = await kbEnv();
  vv.height = 480; vv.offsetTop = 120; fire();
  vv.height = 800; vv.offsetTop = 0;
  let scrolled = 0; a.window.scrollTo = () => { scrolled++; };
  a.window.scrollY = 90;
  fire();
  assert.equal(shell.style.height, "");
  assert.equal(shell.style.transform, "");
  assert.ok(!a.document.documentElement.classList.contains("kb-open"));
  assert.ok(scrolled >= 1, "scrollTo(0,0) после закрытия клавиатуры");
  a.close();
});

test("[iPhone] небольшие колебания viewport (панель Safari) не считаются клавиатурой", async () => {
  const { a, vv, shell, fire } = await kbEnv();
  vv.height = 740; fire();
  assert.equal(shell.style.height, "");
  assert.ok(!a.document.documentElement.classList.contains("kb-open"));
  a.close();
});

test("[iPhone] при открытии клавиатуры переписка прокручивается к последним сообщениям", async () => {
  const { a, vv, fire } = await kbEnv();
  a.run(`state.chatId = "alice"; ensureContactEntry("alice","Alice"); renderTab();`);
  const wrap = a.document.querySelector("#chat-messages");
  Object.defineProperty(wrap, "scrollHeight", { value: 5000, configurable: true });
  wrap.scrollTop = 0;
  vv.height = 480; vv.offsetTop = 120; fire();
  await tick(60);
  assert.equal(wrap.scrollTop, 5000);
  a.close();
});

test("[iPhone] kb-open убирает нижний отступ таб-бара", () => {
  assert.match(css, /html\.kb-open #tab-bar \{ padding-bottom: 0; \}/);
});

// ---------- iPhone PWA: пустая полоса под футером красится в цвет футера ----------
test("[iPhone] фон html — фон приложения (--bg-0), без чёрного clip и без --app-h", () => {
  assert.match(rule("html").match(/background:\s*([^;]+);/g).pop(), /var\(--bg-0\)/);
  assert.doesNotMatch(rule("body"), /--app-h/);
});
test("[iPhone] футер использует тот же токен --glass-regular", () => {
  assert.match(rule(".glass,\n.glass-regular"), /background:\s*var\(--glass-regular\)/);
});

// ---------- Футер, safe area, запрет зума и поворота ----------
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.webmanifest"), "utf8"));
const appJs = fs.readFileSync(path.join(ROOT, "js/app.js"), "utf8");

test("футер: подчёркивание активной вкладки удалено (разметка, стили, скрипт)", async () => {
  assert.doesNotMatch(html, /tab-indicator/);
  assert.doesNotMatch(css, /tab-indicator/);
  assert.doesNotMatch(appJs, /updateTabIndicator|tab-indicator/);
  const a = await bootApp({ platform: "ios", standalone: true });
  assert.equal(a.document.querySelector("#tab-indicator"), null);
  a.document.querySelector('.tab-btn[data-tab="settings"]').click();
  assert.ok(a.document.querySelector('.tab-btn[data-tab="settings"]').classList.contains("active"));
  a.close();
});

test("футер: по 10px сверху и снизу вокруг содержимого кнопок, фиксированной высоты нет", () => {
  assert.match(rule(".tab-btn"), /padding:\s*10px 0/);
  assert.doesNotMatch(rule("#tab-bar"), /(^|[;\s])height:\s*\d+px/);
  assert.match(rule("#tab-bar"), /padding:\s*0 4px env\(safe-area-inset-bottom, 0px\)/);
  assert.doesNotMatch(rule("#tab-bar"), /safe-area-inset-bottom, 0px\) \+/);
});

test("футер и нижняя safe area: стекло как у хедера, без собственного сплошного фона", () => {
  assert.doesNotMatch(css, /--footer-bg/);
  assert.doesNotMatch(rule("#tab-bar"), /(^|[;\s])background:/, "фон футера даёт .glass (var(--glass-regular))");
  assert.match(rule("#nav-bar") + css.match(/#nav-bar\.glass[^{]*\{[^}]*\}/)?.[0], /blur|glass|padding/);
  assert.match(rule(".glass,\n.glass-regular"), /background:\s*var\(--glass-regular\)/);
  assert.match(html, /<nav id="tab-bar" class="glass">/);
});

test("запрет масштабирования: viewport, touch-action, блокировка жестов и двойного тапа", async () => {
  assert.match(html.match(/<meta name="viewport" content="([^"]+)"/)[1], /maximum-scale=1, user-scalable=no/);
  assert.match(rule("html, body"), /touch-action:\s*pan-x pan-y/);
  const a = await bootApp({ platform: "ios", standalone: true });
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    const ev = new a.window.Event(type, { cancelable: true, bubbles: true });
    a.document.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true, type + " должен блокироваться (щипок)");
  }
  const mv = new a.window.Event("touchmove", { cancelable: true, bubbles: true }); mv.touches = [{}, {}];
  a.document.dispatchEvent(mv);
  assert.equal(mv.defaultPrevented, true, "двухпальцевое движение блокируется");
  const one = new a.window.Event("touchmove", { cancelable: true, bubbles: true }); one.touches = [{}];
  a.document.dispatchEvent(one);
  assert.equal(one.defaultPrevented, false, "обычный скролл одним пальцем не трогаем");
  const t1 = new a.window.Event("touchend", { cancelable: true, bubbles: true });
  a.document.dispatchEvent(t1);
  const t2 = new a.window.Event("touchend", { cancelable: true, bubbles: true });
  a.document.dispatchEvent(t2);
  assert.equal(t2.defaultPrevented, true, "второй тап подряд (зум двойным тапом) блокируется");
  a.close();
});

test("запрет поворота: manifest portrait, screen.orientation.lock('portrait'), оверлей в альбомной ориентации", async () => {
  assert.equal(manifest.orientation, "portrait");
  assert.match(css, /@media \(orientation: landscape\) and \(max-height: 500px\) and \(pointer: coarse\)\s*\{\s*#rotate-lock\s*\{[^}]*position: fixed; inset: 0/);
  assert.match(css, /#rotate-lock \{ display: none; \}/);
  const calls = [];
  const a = await bootApp({ platform: "android", beforeBoot: null });
  a.window.screen.orientation = { lock: (m) => { calls.push(m); return Promise.resolve(); } };
  a.run(`lockViewportGestures()`);
  assert.deepEqual(calls, ["portrait"]);
  a.window.screen.orientation = { lock: () => Promise.reject(new Error("unsupported")) };
  a.run(`lockViewportGestures()`); // отказ iOS не должен ломать приложение
  assert.ok(a.document.querySelector("#rotate-lock"));
  assert.ok(a.window.__LANG_DICTS.en["rotate.lock"] && a.window.__LANG_DICTS.ru["rotate.lock"]);
  a.close();
});

test("диагностика: метрики вьюпорта для разбора safe area на iPhone", async () => {
  const a = await bootApp({ platform: "ios", standalone: true });
  const text = a.run(`buildDiagnosticsText()`);
  for (const key of ["--- viewport ---", "Standalone: true", "inner:", "screen:", "visualViewport:", "100vh:", "100dvh:", "100svh:", "100lvh:", "safe-area top/bottom/left/right:", "#tab-bar:", "viewport meta:"]) {
    assert.ok(text.includes(key), "нет строки: " + key);
  }
  assert.doesNotMatch(text, /metrics error/);
  assert.equal(a.document.body.querySelectorAll("div[aria-hidden=true][style*='visibility:hidden']").length, 0, "пробные элементы удаляются");
  a.close();
});

// ---------- iPhone 13 / iOS: layout viewport короче экрана (inner 797 при screen 844) ----------
test("[iPhone PWA] корень не обрезается clip-path (он оставлял чёрную полосу под футером)", () => {
  assert.doesNotMatch(rule("html"), /clip-path/);
});
test("[iPhone PWA] в standalone html/body/оболочка тянутся до 100lvh (полный экран), в обычной вкладке — нет", () => {
  assert.match(css, /@media \(display-mode: standalone\)\s*\{\s*@supports \(height: 100lvh\)\s*\{\s*html, body \{ height: 100lvh; \}/);
  assert.match(css, /html\.is-standalone, html\.is-standalone body \{ height: 100lvh; \}/);
  // базовые правила (вкладка Safari) остаются на 100%
  assert.match(rule("html"), /height:\s*100%/);
  assert.doesNotMatch(rule("body"), /lvh/);
});
test("[iPhone PWA] JS помечает html классом is-standalone только в режиме PWA", async () => {
  const pwa = await bootApp({ platform: "ios", standalone: true });
  assert.ok(pwa.document.documentElement.classList.contains("is-standalone"));
  pwa.close();
  const tab = await bootApp({ platform: "ios", standalone: false });
  assert.ok(!tab.document.documentElement.classList.contains("is-standalone"));
  tab.close();
});
test("[iPhone PWA] диагностика содержит lvh и safe-area (данные iPhone 13 использованы для вывода)", async () => {
  const a = await bootApp({ platform: "ios", standalone: true });
  assert.match(a.run(`buildDiagnosticsText()`), /100lvh:/);
  a.close();
});
