// «Слой удовольствия», волна 2 (js/features2.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const { bootApp, closeAll } = require("./harness");
test.after(closeAll);
const J = (x) => JSON.parse(JSON.stringify(x)); // объекты из vm-контекста сравниваем по значению
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const click = (a, el) => el.dispatchEvent(new a.window.MouseEvent("click", { bubbles: true }));

async function chatApp(extra = {}) {
  const a = await bootApp(extra);
  a.run(`ensureContactEntry("alice","Алиса"); state.contacts.get("alice").publicKey = {kty:"EC", x:"AAA111", y:"BBB222"};`);
  return a;
}
const openChat = (a, id = "alice") => { a.run(`state.chatId = "${id}"; renderTab();`); };
function stubLink(a, id = "alice") {
  const sent = [];
  a.window.__sent = sent;
  a.run(`(() => { const sent = window.__sent; const l = { id: ${JSON.stringify(id)}, status: "connected", send(p) { sent.push(p); return true; } }; const og = mesh.get.bind(mesh); mesh.get = (x) => x === ${JSON.stringify(id)} ? l : og(x); })()`);
  return sent;
}

test("fx2: значения по умолчанию и группа «Ещё эффекты» в настройках (с переключателями)", async () => {
  const a = await chatApp();
  assert.equal(a.run(`FX.get("veil")`), true);
  assert.equal(a.run(`FX.get("ambient")`), false);
  assert.equal(a.run(`FX.get("look")`), false, "Vision Loop по умолчанию выключен — кадры принимаются только по явному включению");
  assert.equal(a.run(`FX.get("weather")`), false, "погода — только opt-in");
  const grp = a.document.querySelector("#fx2-settings-group");
  assert.ok(grp);
  for (const k of ["veil", "wave", "composer", "ambient", "presence", "pulse", "haptics", "look", "draw", "weather", "aurora"]) assert.ok(grp.querySelector("#fxs-" + k), k);
  assert.equal(grp.querySelector("#fxs-aurora").disabled, true, "«Аврора» закрыта, пока нет приглашения");
  const t = grp.querySelector("#fxs-pulse"); t.checked = true; t.dispatchEvent(new a.window.Event("change"));
  assert.equal(a.run(`FX.get("pulse")`), true);
  a.close();
});

test("Занавес при входе в чат и прощальная волна 👋", async () => {
  const a = await chatApp();
  openChat(a);
  assert.ok(a.document.querySelector("#screen-chat").classList.contains("fx-veil"));
  assert.equal(a.run(`FX_GOODBYE.test("ну всё, пока!")`), true);
  assert.equal(a.run(`FX_GOODBYE.test("спокойной ночи")`), true);
  assert.equal(a.run(`FX_GOODBYE.test("покажи")`), false, "«пока» только как отдельное слово");
  assert.equal(a.run(`FX_GOODBYE.test("Bye bye")`), true);
  await a.run(`sendChatMessage("alice", "ладно, до завтра")`);
  assert.ok(a.document.querySelector(".fx-wave"));
  a.run(`FX.set("wave", false)`); a.document.querySelector(".fx-wave").remove();
  await a.run(`sendChatMessage("alice", "пока")`);
  assert.equal(a.document.querySelector(".fx-wave"), null);
  a.close();
});

test("Composer Voice: детерминированная тема ≤3 с из ключа, играет через WebAudio только при включении", async () => {
  const a = await chatApp();
  const t1 = a.run(`JSON.stringify(composerThemeFor("k1"))`), t2 = a.run(`JSON.stringify(composerThemeFor("k1"))`), t3 = a.run(`JSON.stringify(composerThemeFor("other"))`);
  assert.equal(t1, t2); assert.notEqual(t1, t3);
  const th = JSON.parse(t1); assert.equal(th.length, 5);
  assert.ok(th[th.length - 1].t + th[th.length - 1].d <= 3.001, "тема не длиннее 3 секунд");
  a.run(`Store.soundsEnabled = true; ensureGlobalAudioCtx();`);
  const before = a.window.__audioNodes.length;
  openChat(a); // composer выключен
  assert.equal(a.window.__audioNodes.length, before);
  a.run(`FX.set("composer", true); state.chatId = null; fx2LastChat = null; openChat = null;`);
  a.run(`state.chatId = "alice"; renderTab();`);
  assert.ok(a.window.__audioNodes.length > before, "тема сыграна");
  a.close();
});

test("Ambient: старт/стоп слоя, колокольчик по таймеру, пауза в фоне", async () => {
  const a = await chatApp();
  a.run(`Store.soundsEnabled = true; ensureGlobalAudioCtx();`);
  assert.equal(a.run(`fxAmbientStart()`), true);
  assert.equal(a.run(`fxAmb.on`), true);
  assert.ok(a.window.__audioNodes.some((n) => n.type === "bufsrc"));
  a.run(`fxAmbientBump()`);
  a.run(`fxAmbientStop()`);
  assert.equal(a.run(`fxAmb.on`), false);
  a.run(`FX.set("ambient", true); fxAmbientSync();`);
  assert.equal(a.run(`fxAmb.on`), true, "включение в настройках запускает слой");
  a.run(`Store.soundsEnabled = false; fxAmbientSync();`);
  assert.equal(a.run(`fxAmb.on`), false, "при выключенных звуках слой замолкает");
  a.close();
});

test("Закрытие дня: ночью после паузы без касаний показывается «До завтра» раз за ночь; кнопка — в любое время", async () => {
  const a = await chatApp();
  const at = (h) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.getTime(); };
  a.run(`fx2LastInput = 0`);
  assert.equal(a.run(`fxDuskCheck(${at(15)})`), false, "днём не срабатывает");
  assert.equal(a.run(`fxDuskCheck(${at(23)})`), true);
  assert.ok(a.document.querySelector(".fx-dusk"));
  a.document.querySelector(".fx-dusk").remove();
  assert.equal(a.run(`fxDuskCheck(${at(23)})`), false, "повторно за ту же ночь — нет");
  a.document.querySelector("#fx-closeday-btn").dispatchEvent(new a.window.MouseEvent("click", { bubbles: true }));
  assert.ok(a.document.querySelector(".fx-dusk"), "кнопка в настройках закрывает день по требованию");
  a.close();
});

test("Мягкий скин: форма пузырей и шрифт — по ключу, сетка не меняется; сезон меняется плавно за 3 дня", async () => {
  const a = await chatApp();
  const tr = JSON.parse(a.run(`JSON.stringify(skinTraits(state.contacts.get("alice")))`));
  assert.ok(["round", "soft", "sharp"].includes(tr.shape) && ["sans", "rounded", "serif"].includes(tr.font));
  assert.deepEqual(tr, JSON.parse(a.run(`JSON.stringify(skinTraits(state.contacts.get("alice")))`)));
  openChat(a);
  assert.equal(a.document.querySelector("#screen-chat").getAttribute("data-skin-shape"), null, "по умолчанию скин выключен");
  a.run(`FX.set("skin", true)`);
  assert.equal(a.document.querySelector("#screen-chat").getAttribute("data-skin-shape"), tr.shape);
  assert.equal(a.document.querySelector("#screen-chat").getAttribute("data-skin-font"), tr.font);
  const y = new Date().getFullYear();
  const h = (m, d, hh = 12) => a.run(`seasonHue(new Date(${y}, ${m}, ${d}, ${hh}).getTime())`);
  assert.equal(h(2, 19), 24, "до 20 марта — зимний оттенок");
  const mid = h(2, 21); assert.ok(mid < 24 && mid > -14, "на 2-й день весны — промежуточный: " + mid);
  assert.equal(h(2, 24), -14, "через 3 дня — полностью весенний");
  assert.equal(h(6, 10), 6, "лето");
  assert.equal(h(10, 10), 18, "осень");
  a.close();
});

test("«Активен сейчас»: кольцо у аватара только в открытом чате при живом соединении", async () => {
  const a = await chatApp();
  stubLink(a);
  openChat(a);
  assert.ok(a.document.querySelector("#chat-peer-avatar").classList.contains("fx-active"));
  a.run(`FX.set("presence", false)`);
  assert.ok(!a.document.querySelector("#chat-peer-avatar").classList.contains("fx-active"));
  a.close();
});

test("Созвездие: звёзды детерминированы, ≤60, без связей; переключатель и переход в чат", async () => {
  const a = await chatApp();
  a.run(`for (let i = 0; i < 70; i++) { const c = ensureContactEntry("u" + i, "User " + i); c.lastActivity = Date.now() - i * 86400000; }`);
  const s1 = a.run(`JSON.stringify(constellationStars(Array.from(state.contacts.values()), 1e12))`), s2 = a.run(`JSON.stringify(constellationStars(Array.from(state.contacts.values()), 1e12))`);
  assert.equal(s1, s2);
  const stars = JSON.parse(s1);
  assert.equal(stars.length, 60, "не больше 60 звёзд");
  assert.ok(stars.every((s) => s.x >= 0 && s.x <= 100 && s.y >= 0 && s.y <= 122 && s.bright > 0 && s.bright <= 1));
  assert.equal(new Set(stars.map((s) => s.x + "," + s.y)).size, stars.length, "звёзды не накладываются в одну точку");
  a.run(`state.tab = "connect"; renderTab();`);
  assert.ok(a.document.querySelector("#fx-view-toggle"));
  click(a, a.document.querySelector('#fx-view-toggle [data-view="constellation"]'));
  const box = a.document.querySelector("#fx-constellation");
  assert.ok(!box.classList.contains("hidden"));
  assert.equal(box.querySelectorAll(".fx-star").length, 60);
  assert.ok(a.document.querySelector("#contacts-list").classList.contains("hidden"));
  click(a, box.querySelector(".fx-star"));
  assert.ok(a.run(`!!state.chatId`));
  a.run(`state.chatId = null; state.tab = "connect"; renderTab(); FX.set("constellation", false);`);
  assert.ok(box.classList.contains("hidden") || a.document.querySelector("#fx-constellation").classList.contains("hidden"));
  a.close();
});

test("Рисование на видео: запрос/согласие, штрихи очищаются от мусора, чужие и вне звонка игнорируются", async () => {
  const a = await chatApp();
  const sent = stubLink(a);
  // вне звонка — запрос отклоняется
  a.run(`handleFxPayload("alice", { kind: "fxdraw", t: "req" })`);
  assert.deepEqual(J(sent.pop()), { kind: "fxdraw", t: "no" });
  // в активном звонке — баннер согласия
  a.run(`state.callId = "alice"; state.callPhase = "active"; openCallScreen("alice", "active");`);
  a.run(`fx2After()`);
  assert.equal(a.document.querySelector("#fx-draw-btn").classList.contains("hidden"), false, "кнопка «Рисовать» видна в звонке");
  a.run(`handleFxPayload("alice", { kind: "fxdraw", t: "req" })`);
  const ask = a.document.querySelector("#fx-ask"); assert.ok(ask);
  assert.equal(a.run(`FXD.active`), false, "без согласия рисовать нельзя");
  click(a, ask.querySelector(".gcall-invite-join"));
  assert.deepEqual(J(sent.pop()), { kind: "fxdraw", t: "ok" });
  assert.equal(a.run(`FXD.active`), true);
  const big = Array.from({ length: 500 }, (_, i) => [i / 100 - 2, 9]);
  a.run(`handleFxPayload("alice", { kind: "fxdraw", t: "s", c: "red;evil", p: ${JSON.stringify(big)} })`);
  const st = JSON.parse(a.run(`JSON.stringify(FXD.strokes[0])`));
  assert.equal(st.pts.length, 240, "точек не больше лимита");
  assert.ok(st.pts.every(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1), "координаты зажаты в 0..1");
  assert.equal(st.c, "#5ac8ff", "невалидный цвет заменяется безопасным");
  a.run(`handleFxPayload("mallory", { kind: "fxdraw", t: "s", p: [[0.1,0.1]] })`);
  assert.equal(a.run(`FXD.strokes.length`), 1, "штрихи не от собеседника по звонку игнорируются");
  a.run(`handleFxPayload("alice", { kind: "fxdraw", t: "stop" })`);
  assert.equal(a.run(`FXD.active`), false);
  assert.equal(a.run(`FXD.strokes.length`), 0, "ничего не сохраняется");
  a.run(`state.callId = null; state.callPhase = null;`);
  a.close();
});

test("Vision Loop: приём только если включён; индикатор у обеих сторон; валидация кадров; конец закрывает", async () => {
  const a = await chatApp();
  const sent = stubLink(a);
  a.run(`handleFxPayload("alice", { kind: "fxlook", t: "start" })`);
  assert.deepEqual(J(sent.pop()), { kind: "fxlook", t: "no" }, "при выключенном Vision Loop взгляд не принимается");
  a.run(`FX.set("look", true); handleFxPayload("alice", { kind: "fxlook", t: "start" })`);
  const view = a.document.querySelector("#fx-look-view"); assert.ok(view);
  assert.match(view.querySelector(".fx-look-note").textContent, /Алиса/);
  a.run(`handleFxPayload("alice", { kind: "fxlook", t: "f", d: "javascript:alert(1)" })`);
  assert.equal(view.querySelector("img").getAttribute("src"), null, "не-JPEG кадры отбрасываются");
  a.run(`handleFxPayload("alice", { kind: "fxlook", t: "f", d: "data:image/jpeg;base64," + "A".repeat(30000) })`);
  assert.equal(view.querySelector("img").getAttribute("src"), null, "слишком большие кадры отбрасываются");
  a.run(`handleFxPayload("alice", { kind: "fxlook", t: "f", d: "data:image/jpeg;base64,AAAA" })`);
  assert.equal(view.querySelector("img").getAttribute("src"), "data:image/jpeg;base64,AAAA");
  a.run(`handleFxPayload("alice", { kind: "fxlook", t: "end" })`);
  assert.equal(a.document.querySelector("#fx-look-view"), null);
  a.close();
});

test("Vision Loop (отправитель): подтверждение, ~3 секунды кадров, индикатор «камера открыта», камера выключается", async () => {
  const a = await chatApp();
  const sent = stubLink(a);
  a.run(`FX.set("look", true); openChat = null; state.chatId = "alice"; renderTab();`);
  assert.equal(a.document.querySelector("#fx-look-btn").classList.contains("hidden"), false);
  let stopped = 0, seenIndicator = false;
  a.window.navigator.mediaDevices.getUserMedia = async () => ({ getVideoTracks: () => [{ stop() { stopped++; } }], getTracks: () => [{ stop() { stopped++; } }] });
  a.run(`confirmSheet = async () => true; fxLookFrame = () => "data:image/jpeg;base64,QUJD";`);
  const p = a.run(`fxLookStart("alice")`);
  await tick(500); seenIndicator = !!a.document.querySelector("#fx-look-self .fx-look-dot");
  await p;
  assert.ok(seenIndicator, "у отправителя виден индикатор открытой камеры");
  assert.equal(sent[0].t, "start");
  assert.ok(sent.filter((m) => m.t === "f").length >= 6, "кадры ушли");
  assert.equal(sent[sent.length - 1].t, "end");
  assert.ok(stopped >= 1, "камера остановлена");
  assert.equal(a.document.querySelector("#fx-look-self"), null);
  a.close();
});

test("Мини-треды реакций: тап по реакции открывает тред; ответы привязаны к реакции и видны собеседнику как reply", async () => {
  const a = await chatApp();
  const sent = stubLink(a);
  a.run(`state.contacts.get("alice").messages.push({ id: "m1", from: "them", text: "Погнали в кино?", ts: Date.now(), reactions: { "❤️": ["me-test-id"] } });`);
  openChat(a);
  const chip = a.document.querySelector(".bubble-reaction-chip");
  assert.equal(chip.getAttribute("data-emoji"), "❤️");
  click(a, chip);
  const sheet = a.document.querySelector("#fx-thread-sheet"); assert.ok(sheet);
  assert.match(sheet.textContent, /Погнали в кино/);
  assert.match(sheet.querySelector(".fx-thread-list").textContent, /Пока нет|No replies/);
  sheet.querySelector("input").value = "Да, в 8!";
  click(a, sheet.querySelector("button"));
  await tick(60);
  const msgs = a.run(`JSON.stringify(state.contacts.get("alice").messages.filter((m) => m.from === "me"))`);
  const mine = JSON.parse(msgs)[0];
  assert.equal(mine.text, "Да, в 8!");
  assert.equal(mine.replyTo.id, "m1");
  assert.ok(mine.replyTo.text.startsWith("❤️⁣"), "метка реакции в reply");
  assert.equal(a.run(`fxThreadReplies(state.contacts.get("alice"), "m1", "❤️").length`), 1);
  assert.equal(a.run(`fxThreadReplies(state.contacts.get("alice"), "m1", "👍").length`), 0, "тред привязан к конкретной реакции");
  a.close();
});

test("Time Capsule Wall: открытки из избранных сообщений, пустое состояние", async () => {
  const a = await chatApp();
  a.run(`state.contacts.get("alice").messages.push({ id: "f1", from: "them", text: "Люблю тебя", ts: 1000, favorite: true }, { id: "f2", from: "me", text: "не избранное", ts: 2000 }, { id: "f3", from: "me", text: "и я тебя", ts: 3000, favorite: true });`);
  assert.equal(a.run(`fxWallItems(state.contacts.get("alice")).length`), 2);
  const wall = a.run(`fxOpenWall("alice")`);
  assert.equal(a.document.querySelectorAll(".fx-card").length, 2);
  click(a, a.document.querySelector(".fx-wall-close"));
  assert.equal(a.document.querySelector("#fx-wall"), null);
  a.run(`state.contacts.get("alice").messages.forEach((m) => { m.favorite = false; }); fxOpenWall("alice")`);
  assert.match(a.document.querySelector(".fx-wall-grid").textContent, /избранное|favorites/i);
  a.close();
});

test("Replay месяца: статистика и сцены ≤30 с; без MediaRecorder честно сообщает", async () => {
  const a = await chatApp();
  const d = (day, h = 12) => new Date(2026, 4, day, h).getTime();
  a.run(`state.contacts.get("alice").messages.push(
    { id: "r1", from: "them", text: "Привет! Как твои дела сегодня?", ts: ${d(2)} },
    { id: "r2", from: "me", text: "Отлично 😀😀 а у тебя?", ts: ${d(2, 13)}, reactions: { "❤️": ["alice"] } },
    { id: "r3", from: "them", text: "Тоже здорово, увидимся!", ts: ${d(20)} },
    { id: "r4", from: "me", text: "коротко", ts: ${d(20, 13)} },
    { id: "old", from: "me", text: "старое сообщение не из мая", ts: ${new Date(2026, 3, 1).getTime()} });`);
  const data = JSON.parse(a.run(`JSON.stringify(replayData(state.contacts.get("alice"), 2026, 4))`));
  assert.equal(data.count, 4);
  assert.equal(data.sent, 2); assert.equal(data.received, 2);
  assert.equal(data.busiest.count, 2);
  assert.equal(data.topEmoji, "😀");
  assert.equal(data.pauseDays, 17);
  assert.ok(data.quotes.length >= 2 && data.quotes.length <= 5);
  assert.ok(data.quotes.every((q) => q.text.length >= 8), "слишком короткие реплики не берутся");
  const scenes = JSON.parse(a.run(`JSON.stringify(replayScenes(replayData(state.contacts.get("alice"), 2026, 4), state.contacts.get("alice"), 2026, 4))`));
  assert.ok(scenes.reduce((s, x) => s + x.dur, 0) <= 30);
  assert.equal(scenes[0].kind, "title"); assert.equal(scenes[scenes.length - 1].kind, "outro");
  assert.equal(a.run(`replayData(state.contacts.get("alice"), 2020, 0)`), null, "пустой месяц");
  assert.equal(await a.run(`fxMakeReplay("alice", 2026, 4)`), false);
  assert.ok(a.document.querySelector("#toast").textContent.length > 0, "сообщение о неподдерживаемой записи");
  a.close();
});

test("Костёр: временная комната с сроком в описании; по истечении удаляется", async () => {
  const a = await chatApp();
  const id = a.run(`fxCreateCampfire(4)`);
  const g = JSON.parse(a.run(`JSON.stringify(state.contacts.get(${JSON.stringify(id)}))`));
  assert.equal(g.isGroup, true);
  assert.ok(g.name.startsWith("🔥"));
  const until = a.run(`fxCampfireUntil(state.contacts.get(${JSON.stringify(id)}))`);
  assert.ok(until > Date.now() + 3.9 * 3600 * 1000 && until < Date.now() + 4.1 * 3600 * 1000);
  assert.equal(a.run(`fxSweepCampfires(Date.now())`), 0, "до срока комната живёт");
  assert.ok(a.run(`state.contacts.has(${JSON.stringify(id)})`));
  assert.equal(a.run(`fxSweepCampfires(${until + 1000})`), 1);
  assert.equal(a.run(`state.contacts.has(${JSON.stringify(id)})`), false, "после срока комната исчезает");
  assert.equal(a.run(`fxCampfireUntil({ description: "обычное описание" })`), 0);
  a.close();
});

test("Бонус «Аврора»: открывается приглашением (обе стороны), чисто косметический", async () => {
  const a = await chatApp();
  assert.equal(a.run(`fxAuroraUnlocked()`), false);
  assert.equal(a.run(`fxReferralUnlock()`), true);
  assert.equal(a.run(`fxReferralUnlock()`), false, "повторно не срабатывает");
  assert.equal(a.run(`fxAuroraUnlocked()`), true);
  const t = a.document.querySelector("#fxs-aurora");
  a.run(`fx2After()`);
  assert.equal(t.disabled, false);
  t.checked = true; t.dispatchEvent(new a.window.Event("change"));
  assert.ok(a.document.documentElement.classList.contains("fx-aurora"));
  a.close();
  const b = await chatApp();
  b.run(`joinGroupViaInvite("ether://group?gid=g9&ref=someone&rn=Bob&gn=Team")`);
  await tick(50);
  assert.equal(b.run(`fxAuroraUnlocked()`), true, "принявший приглашение получает бонус");
  b.close();
});

test("Погодный оттенок: только после явного согласия; координаты не сохраняются; коды погоды → вид неба", async () => {
  const a = await chatApp();
  assert.equal(a.run(`skyKindFor(0, true)`), "clear"); assert.equal(a.run(`skyKindFor(0, false)`), "night");
  assert.equal(a.run(`skyKindFor(63, true)`), "rain"); assert.equal(a.run(`skyKindFor(73, true)`), "snow");
  assert.equal(a.run(`skyKindFor(95, true)`), "storm"); assert.equal(a.run(`skyKindFor(45, true)`), "fog");
  let fetched = [];
  a.window.fetch = async (url) => { fetched.push(String(url)); return { ok: true, json: async () => ({ current: { weather_code: 61, is_day: 1 } }) }; };
  a.window.navigator.geolocation = { getCurrentPosition: (ok) => ok({ coords: { latitude: 55.7558, longitude: 37.6173 } }) };
  a.run(`confirmSheet = async () => false;`);
  assert.equal(await a.run(`fxEnableWeather()`), false);
  assert.equal(fetched.length, 0, "без согласия — ни одного запроса");
  assert.equal(a.document.documentElement.getAttribute("data-sky"), null);
  a.run(`confirmSheet = async () => true;`);
  assert.equal(await a.run(`fxEnableWeather()`), true);
  assert.equal(fetched.length, 1);
  assert.match(fetched[0], /open-meteo\.com.*latitude=55\.8.*longitude=37\.6/, "координаты округлены до ~10 км");
  assert.equal(a.document.documentElement.getAttribute("data-sky"), "rain");
  const stored = JSON.stringify(Object.assign({}, a.window.localStorage));
  assert.ok(!/55\.7|37\.6/.test(stored), "точные координаты нигде не сохраняются");
  a.close();
});

test("Краевой пульс и хаптика: пульс только при видимом приложении; вибрации — только Android и только по включению", async () => {
  const a = await chatApp({ platform: "android" });
  const vib = []; a.window.navigator.vibrate = (p) => { vib.push(p); return true; };
  assert.equal(a.run(`fxHaptic("send")`), false, "по умолчанию выключено");
  a.run(`FX.set("haptics", true)`);
  assert.equal(a.run(`fxHaptic("recv")`), true);
  assert.deepEqual(J(vib.pop()), [14, 40, 14]);
  a.run(`FX.set("pulse", true); playMessageSound("alice");`);
  assert.ok(a.document.querySelector(".fx-pulse"));
  a.close();
  const ios = await chatApp({ platform: "ios" });
  ios.window.navigator.vibrate = () => true;
  ios.run(`FX.set("haptics", true)`);
  assert.equal(ios.run(`fxHaptic("send")`), false, "на iOS вибраций нет");
  ios.close();
});

test("Call Film: небиометрическая сводка группового звонка (длительность, участники, сообщения)", async () => {
  const a = await chatApp();
  a.run(`state.contacts.set("g1", { id: "g1", isGroup: true, name: "Team", members: [], messages: [{ id: "x", from: "them", text: "hi", ts: Date.now() }] });`);
  const el = a.run(`fxCallFilm({ gid: "g1", start: Date.now() - 65000, names: ["Bob", "Eve"], had: true })`);
  assert.ok(a.document.querySelector(".fx-callfilm"));
  const txt = a.document.querySelector(".fx-callfilm").textContent;
  assert.match(txt, /Team/); assert.match(txt, /3/); assert.match(txt, /1/);
  a.close();
});

test("Усиленная реакция: долгий тап по эмодзи даёт серию вспышек, обычный — одну", async () => {
  const a = await chatApp();
  const host = a.document.createElement("div"); a.document.body.appendChild(host);
  a.run(`spawnReactionBurst(document.body.lastElementChild, "🔥")`);
  assert.equal(host.querySelectorAll(".reaction-burst").length, 1);
  a.run(`fxBigReaction = true; spawnReactionBurst(document.body.lastElementChild, "🔥")`);
  await tick(500);
  assert.ok(host.querySelectorAll(".reaction-burst").length >= 2, "серия вспышек");
  assert.equal(a.run(`fxBigReaction`), false, "флаг сбрасывается");
  a.close();
});

test("Настройки: названия категорий перерисовываются при смене языка (раньше оставались на языке первого рендера)", async () => {
  const a = await chatApp();
  a.run(`state.tab = "settings"; renderTab();`);
  const labels = () => Array.from(a.document.querySelectorAll(".settings-category-label")).map((e) => e.textContent);
  assert.equal(labels()[0], "Profile");
  a.window.__LANG_DICTS.de = Object.assign({}, a.window.__LANG_DICTS.en, { "settings.category.profile": "Profil-DE", "settings.category.help": "Hilfe-DE" });
  a.run(`I18N.setLang("de"); applyStaticTranslations();`);
  assert.equal(labels()[0], "Profil-DE");
  assert.equal(labels()[5], "Hilfe-DE");
  a.run(`openSettingsCategory("help")`);
  assert.equal(a.document.querySelector("#settings-category-title").textContent, "Hilfe-DE");
  a.close();
});

test("Настройки: поле поиска — первый элемент страницы и закреплено вверху (как на других вкладках)", async () => {
  const a = await chatApp();
  const scr = a.document.querySelector("#screen-settings");
  assert.equal(scr.firstElementChild.className.includes("search-wrap"), true);
  assert.ok(scr.querySelector("#settings-search"));
  const css = require("fs").readFileSync(require("path").join(__dirname, "..", "css", "styles.css"), "utf8");
  assert.match(css, /#screen-settings > \.search-wrap\s*\{[^}]*position:\s*sticky/);
  a.close();
});

test("Словари: все fx*/gcall* ключи есть во всех 72 языках (кроме английского фолбэка — он полный)", async () => {
  const fs = require("fs"), path = require("path");
  const dir = path.join(__dirname, "..", "js", "lang");
  const en = fs.readFileSync(path.join(dir, "en.js"), "utf8");
  const keys = Array.from(en.matchAll(/^\s*"((?:fx2?|gcall)\.[^"]+)":/gm)).map((m) => m[1]);
  assert.ok(keys.length >= 110, "ключей: " + keys.length);
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    const missing = keys.filter((k) => !src.includes(`"${k}":`));
    assert.deepEqual(missing, [], f + " без ключей");
  }
});
