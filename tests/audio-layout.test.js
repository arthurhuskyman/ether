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

test("[iPhone] после закрытия клавиатуры страница возвращается в scrollY=0 (нет полосы под футером)", async () => {
  const a = await bootApp({ platform: "ios", standalone: true });
  const vv = new a.window.EventTarget();
  Object.assign(vv, { height: 800, offsetTop: 0 });
  Object.defineProperty(a.window, "visualViewport", { value: vv, configurable: true });
  let scrolled = 0;
  a.window.scrollTo = () => { scrolled++; };
  Object.defineProperty(a.window, "scrollY", { value: 120, configurable: true });
  Object.defineProperty(a.window, "innerHeight", { value: 800, configurable: true });
  a.run(`wireKeyboardFix()`);
  a.run(`state.chatId = "alice"; ensureContactEntry("alice","Alice"); renderTab();`);
  a.document.querySelector("#screen-chat").classList.remove("hidden");
  vv.dispatchEvent(new a.window.Event("resize"));
  assert.ok(scrolled >= 1, "scrollTo(0,0) при отсутствии клавиатуры");
  // и по уходу фокуса с поля
  scrolled = 0;
  a.document.dispatchEvent(new a.window.Event("focusout"));
  await tick(150);
  assert.ok(scrolled >= 1);
  a.close();
});

test("[iPhone] клавиатура открыта (viewport уменьшился): скролл страницы не трогаем, input-bar поднимается", async () => {
  const a = await bootApp({ platform: "ios", standalone: true });
  const vv = new a.window.EventTarget();
  Object.assign(vv, { height: 400, offsetTop: 0 });
  Object.defineProperty(a.window, "visualViewport", { value: vv, configurable: true });
  Object.defineProperty(a.window, "innerHeight", { value: 800, configurable: true });
  Object.defineProperty(a.window, "scrollY", { value: 50, configurable: true });
  let scrolled = 0; a.window.scrollTo = () => { scrolled++; };
  a.run(`wireKeyboardFix()`);
  a.run(`state.chatId = "alice"; ensureContactEntry("alice","Alice"); renderTab();`);
  a.document.querySelector("#screen-chat").classList.remove("hidden");
  vv.dispatchEvent(new a.window.Event("resize"));
  assert.equal(scrolled, 0);
  assert.match(a.document.querySelector(".chat-input-bar").style.transform, /translateY\(-/);
  a.close();
});

test("[iPhone] ширина: контент не шире экрана (overflow-x, text-size-adjust, сжатие медиа и длинных слов)", () => {
  assert.match(rule("html, body"), /width:\s*100%/);
  assert.match(rule("html, body"), /max-width:\s*100%/);
  assert.match(rule("html, body"), /overflow-x:\s*hidden/);
  assert.match(rule("html, body"), /-webkit-text-size-adjust:\s*100%/);
  assert.match(rule("#app-shell, .screen, #content"), /min-width:\s*0/);
  assert.match(rule("img, video, canvas, svg, iframe"), /max-width:\s*100%/);
  assert.match(rule(".bubble, .bubble-row, .chat-row, .settings-row, .contact-row"), /overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(css, /width:\s*100vw/, "100vw на iOS включает системные поля и вызывает горизонтальное переполнение");
  assert.match(html.match(/<meta name="viewport" content="([^"]+)"/)[1], /width=device-width/);
});

// ---------- iPhone PWA: пустая полоса под футером красится в цвет футера ----------
test("[iPhone] фон html (виден под body) — цвет стекла футера, а не чёрный", () => {
  const bg = rule("html").match(/background:\s*([^;]+);/g).pop();
  assert.match(bg, /var\(--glass-regular\)/);
  assert.match(bg, /var\(--bg-0\)/);
  assert.doesNotMatch(rule("body"), /--app-h/);
});
test("[iPhone] футер использует тот же токен --glass-regular", () => {
  assert.match(rule(".glass,\n.glass-regular"), /background:\s*var\(--glass-regular\)/);
});
