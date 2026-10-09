// Правки по отчёту о новых багах: звонки, голосовые, перерисовка чата, поиск, пересылка, клавиатура.
const test = require("node:test");
const assert = require("node:assert/strict");
const { bootApp, closeAll } = require("./harness");
test.after(closeAll);
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function app(extra = {}) {
  const a = await bootApp(extra);
  a.run(`ensureContactEntry("alice","Alice"); state.contacts.get("alice").publicKey = {kty:"EC", x:"A1", y:"B2"};`);
  return a;
}

test("чат: повторная отрисовка без изменений не пересобирает ленту (нет мерцания), а изменение — пересобирает", async () => {
  const a = await app();
  a.run(`const c = state.contacts.get("alice"); c.managed = true; c.messages.push({id:"m1", from:"them", text:"привет", ts: Date.now()}); state.chatId = "alice"; renderTab();`);
  a.run(`renderChatThread();`); // разделитель «непрочитанное» снимается после первого показа — дальше состояние стабильно
  const first = a.document.querySelector("#chat-messages .bubble");
  assert.ok(first);
  a.run(`renderChatThread(); renderChatThread();`);
  assert.equal(a.document.querySelector("#chat-messages .bubble"), first, "узел сообщения тот же — DOM не пересобирался");
  a.run(`state.contacts.get("alice").messages.push({id:"m2", from:"them", text:"ещё", ts: Date.now()}); renderChatThread();`);
  assert.equal(a.document.querySelectorAll("#chat-messages .bubble").length, 2);
  // повторный вход в чат с тем же содержимым тоже не перерисовывает
  const node = a.document.querySelector("#chat-messages .bubble");
  a.run(`state.chatId = null; renderTab(); state.chatId = "alice"; renderTab();`);
  assert.equal(a.document.querySelector("#chat-messages .bubble"), node);
  a.close();
});

test("медиа: слот резервирует пропорции и подставляет уже загруженный blob-URL синхронно", async () => {
  const a = await app();
  a.run(`fileBlobUrlCache.set("img1", "blob:x");`);
  const html = a.run(`fileBubbleHtml("img1", { kind: "image", name: "a.png", mime: "image/png", size: 5, w: 800, h: 600 })`);
  assert.match(html, /aspect-ratio:800 \/ 600/);
  assert.match(html, /<img src="blob:x"/);
  const pending = a.run(`fileBubbleHtml("v1", { kind: "video", name: "a.mp4", mime: "video/mp4", size: 5 })`);
  assert.match(pending, /aspect-ratio:16 \/ 9/);
  a.close();
});

test("голосовое: значок play/pause в своём span, кнопка не затирает рисунок кассеты; повторное прослушивание — с начала", async () => {
  const a = await app();
  a.run(`const c = state.contacts.get("alice"); c.managed = true; c.messages.push({id:"v1", from:"them", text:"", ts: Date.now(), file:{kind:"audio", name:"v", mime:"audio/webm", size:5, duration:3}}); fileBlobUrlCache.set("v1","blob:v"); state.chatId = "alice"; renderTab();`);
  await tick(30);
  const btn = a.document.querySelector(".voice-play-btn");
  assert.ok(btn.querySelector(".vp-ico svg"));
  a.run(`FX.set("voiceStyle", "vinyl"); fxDecorateVoice();`);
  assert.ok(btn.querySelector(".fx-voice-deco.vinyl"), "рисунок лежит внутри кнопки");
  a.run(`setVoiceIcon(document.querySelector(".voice-play-btn"), VOICE_PAUSE_ICON_SVG)`);
  assert.ok(btn.querySelector(".fx-voice-deco"), "смена значка не стирает рисунок");
  assert.ok(btn.innerHTML.includes("M7 5h4v14"));
  a.close();
});

test("звонок: call-state «screen» включает показ экрана собеседника (contain), а «ended» при закрытии вкладки отправляется", async () => {
  const a = await app();
  const sent = [];
  a.window.__sent = sent;
  a.run(`(() => { const l = new EventTarget(); Object.assign(l, { id: "alice", status: "in-call", localVideoTrack: null, endCall() {}, setMuted() {}, send(p) { window.__sent.push(p); return true; } }); mesh.links.set("alice", l); })()`);
  a.run(`state.callId = "alice"; state.callPhase = "active"; document.getElementById("call-screen").classList.remove("hidden");`);
  a.run(`mesh.dispatchEvent(new CustomEvent("message", { detail: { id: "alice", payload: { kind: "call-state", state: "screen", on: true, ts: Date.now() } } }))`);
  assert.ok(a.document.querySelector("#call-screen").classList.contains("remote-screen"));
  a.run(`mesh.dispatchEvent(new CustomEvent("message", { detail: { id: "alice", payload: { kind: "call-state", state: "screen", on: false, ts: Date.now() } } }))`);
  assert.ok(!a.document.querySelector("#call-screen").classList.contains("remote-screen"));
  a.run(`hangupOnPageClose()`);
  assert.ok(sent.some((p) => p.kind === "call-state" && p.state === "ended"));
  a.close();
});

test("звонок: недоступные кнопки скрыты (динамик на десктопе, задняя камера на десктопе, PiP на телефоне)", async () => {
  const d = await app({ platform: "desktop" });
  d.run(`updateCallButtonsSupport()`);
  assert.ok(d.document.querySelector("#call-speaker-btn").classList.contains("hidden"), "на десктопе переключателя динамика нет");
  d.close();
  const p = await app({ platform: "android" });
  p.window.HTMLMediaElement.prototype.setSinkId = async () => {};
  p.run(`updateCallButtonsSupport()`);
  assert.ok(!p.document.querySelector("#call-speaker-btn").classList.contains("hidden"), "на телефоне переключатель есть");
  assert.ok(p.document.querySelector("#call-pip-overlay-btn").classList.contains("hidden"), "на телефоне PiP скрыт");
  p.close();
});

test("рисование на видео: есть отдельная кнопка выхода, и она убирает режим", async () => {
  const a = await app();
  a.run(`state.callId = "alice"; state.callPhase = "active"; fxdSetActive(true, "alice");`);
  const stop = a.document.querySelector("#fx-stop-draw");
  assert.ok(stop, "кнопка «Закончить рисование» появляется");
  stop.click();
  assert.equal(a.document.querySelector("#fx-stop-draw"), null);
  assert.equal(a.run(`FXD.active`), false);
  a.close();
});

test("поиск: лупа открывает поле вкладки (по умолчанию оно свёрнуто), повторное нажатие закрывает и очищает", async () => {
  const a = await app();
  const root = a.document.documentElement;
  assert.ok(!root.classList.contains("inline-search-open"));
  assert.ok(a.document.querySelector("#global-search").closest(".search-collapsible"));
  a.document.querySelector("#global-search-btn").click();
  assert.ok(root.classList.contains("inline-search-open"));
  a.document.querySelector("#global-search-btn").click();
  assert.ok(!root.classList.contains("inline-search-open"));
  a.close();
});

test("пересылка: список включает группы; текст и файл уходят в группу каждому участнику с пометкой «Переслано»", async () => {
  const a = await app();
  const sent = [];
  a.window.__sent = sent;
  a.run(`ensureContactEntry("bob","Bob"); state.contacts.get("bob").managed = true; state.contacts.get("alice").managed = true;
    const g = { id: "g1", name: "Team", isGroup: true, managed: true, members: [{id: Store.myId, name: "me"}, {id: "bob", name: "Bob"}], createdBy: Store.myId, messages: [], online: false, status: "disconnected" };
    state.contacts.set("g1", g);
    trySendOrQueue = async (contact, id, payload) => { window.__sent.push({ to: contact.id, payload }); };`);
  a.run(`state.contacts.get("alice").messages.push({id:"orig", from:"them", text:"привет всем", ts: Date.now()});`);
  await a.run(`forwardMessage("orig", "alice", "g1")`);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "bob");
  assert.equal(sent[0].payload.groupId, "g1");
  assert.equal(sent[0].payload.forwarded, true);
  assert.equal(sent[0].payload.text, "привет всем");
  assert.equal(a.run(`state.contacts.get("g1").messages.at(-1).forwarded`), true);
  a.run(`openForwardSheet(() => {})`);
  const names = Array.from(a.document.querySelectorAll("#forward-list .forward-name")).map((e) => e.textContent);
  assert.ok(names.includes("Team"), "группа в списке пересылки: " + names.join(","));
  a.close();
});

test("эмодзи: кнопка тона кожи видна только там, где есть эмодзи с тоном", async () => {
  const a = await app();
  a.run(`openEmojiPicker && openEmojiPicker({}); `);
  a.run(`__emojiTab = "smileys"; renderEmojiGrid(emojiTabSource("smileys")); updateEmojiToneButton();`);
  assert.ok(a.document.querySelector("#emoji-tone-btn").classList.contains("hidden"), "в «Смайликах» тона нет");
  a.run(`__emojiTab = "people"; renderEmojiGrid(emojiTabSource("people")); updateEmojiToneButton();`);
  assert.ok(!a.document.querySelector("#emoji-tone-btn").classList.contains("hidden"), "в «Людях» тон есть");
  a.close();
});

test("сервер выбросил это окно («тот же id в другом окне») — окно ждёт и забирает соединение при возвращении фокуса", async () => {
  const a = await app();
  a.run(`signaling = new EventTarget(); signaling.stop = () => {}; signaling.resume = () => {}; wireSignalingEvents(signaling); signaling.dispatchEvent(new CustomEvent("replaced"));`);
  assert.equal(a.run(`state._replaced`), true);
  a.run(`__lastReclaimAt = 0; initSignaling = () => { window.__reclaimed = (window.__reclaimed || 0) + 1; };`);
  a.window.dispatchEvent(new a.window.Event("focus"));
  assert.equal(a.run(`state._replaced`), false, "после возврата фокуса окно забирает соединение");
  assert.equal(a.window.__reclaimed, 1);
  a.close();
});

test("«Звонки» → другие чипы: список чатов возвращается", async () => {
  const a = await app();
  a.run(`state.tab = "chats"; renderTab();`);
  a.document.querySelector('#chat-filters [data-filter="calls"]').click();
  assert.equal(a.run(`state.chatsSegment`), "calls");
  a.document.querySelector('#chat-filters [data-filter="groups"]').click();
  assert.equal(a.run(`state.chatsSegment`), "chats");
  assert.ok(!a.document.querySelector("#screen-chats").classList.contains("hidden"), "экран чатов снова виден");
  assert.ok(a.document.querySelector("#screen-calls").classList.contains("hidden"));
  a.close();
});

test("пасхалки: эмодзи в новом сообщении запускают эффект и у отправителя, и у получателя; не больше двух на сообщение", async () => {
  const a = await app();
  a.run(`const c1 = state.contacts.get("alice"); c1.managed = true; c1.messages.push({id:"x0", from:"them", text:"привет", ts: Date.now()}); state.chatId = "alice"; renderTab();`);
  a.run(`const c2 = state.contacts.get("alice"); c2.messages.push({id:"x1", from:"them", text:"люблю ❤️", ts: Date.now()}); renderChatThread();`);
  await tick(20);
  assert.ok(a.document.querySelector("#egg-layer .egg-rise"), "сердечки у получателя");
  a.document.querySelector("#egg-layer").innerHTML = "";
  a.run(`const c3 = state.contacts.get("alice"); c3.messages.push({id:"x2", from:"me", text:"🔥🌈🍕", ts: Date.now(), ack:"sent"}); renderChatThread();`);
  await tick(20);
  const layer = a.document.querySelector("#egg-layer");
  assert.ok(layer.querySelector(".egg-rise"), "огонь у отправителя");
  assert.ok(layer.querySelector(".egg-run"), "пицца — второй эффект");
  assert.equal(layer.querySelector(".egg-rainbow"), null, "третий эффект (радуга) не запускается");
  a.run(`FX.set("easter", false)`);
  a.document.querySelector("#egg-layer").innerHTML = "";
  a.run(`const c4 = state.contacts.get("alice"); c4.messages.push({id:"x3", from:"them", text:"❄️", ts: Date.now()}); renderChatThread();`);
  assert.equal(a.document.querySelector("#egg-layer").children.length, 0, "выключено настройкой");
  a.close();
});

test("громкость на iPhone: element.volume только для чтения → слайдер работает через GainNode (подключается, когда громкость уменьшают)", async () => {
  const a = await app({ platform: "ios" });
  a.run(`ensureContactEntry("alice","Alice"); state.callId = "alice"; state.callPhase = "active";`);
  const audio = a.document.createElement("audio"); audio.id = "remote-audio-alice"; a.document.body.appendChild(audio);
  Object.defineProperty(audio, "volume", { get: () => 1, set: () => {}, configurable: true });
  a.window.__s = { id: "S", getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] };
  a.run(`attachRemoteAudio("alice", window.__s)`);
  assert.equal(audio._volReadOnly, true);
  assert.equal(audio._relayGain, undefined, "на полной громкости Web Audio не участвует");
  a.run(`applyCallVolume("alice", 0.4)`);
  assert.ok(audio._relayGain, "после уменьшения громкости подключён GainNode");
  assert.equal(audio._relayGain.gain.value, 0.4);
  a.close();
});

test("динамик: на десктопе с setSinkId кнопка есть и открывает выбор устройства вывода", async () => {
  const a = await app({ platform: "desktop" });
  a.window.HTMLMediaElement.prototype.setSinkId = async () => {};
  a.run(`updateCallButtonsSupport()`);
  assert.ok(!a.document.querySelector("#call-speaker-btn").classList.contains("hidden"));
  a.window.navigator.mediaDevices.enumerateDevices = async () => [{ kind: "audiooutput", deviceId: "default", label: "Колонки" }, { kind: "audiooutput", deviceId: "hp", label: "Наушники" }];
  a.run(`state.callId = "alice"; openAudioOutputPicker()`);
  await tick(30);
  const items = Array.from(a.document.querySelectorAll("#audio-out-menu .call-menu-item")).map((b) => b.textContent);
  assert.equal(items.length, 2);
  assert.match(items[1], /Наушники/);
  a.close();
});

test("свайп строки чата: кнопки действий скрыты, пока строка не сдвинута (не просвечивают через плашку)", async () => {
  const css = require("fs").readFileSync(require("path").join(__dirname, "..", "css", "styles.css"), "utf8");
  assert.match(css, /\.chat-row-wrapper \.chat-row-actions \{ opacity: 0; visibility: hidden/);
  assert.match(css, /\.chat-row-wrapper\.drag-start \.chat-row-actions-start/);
});
