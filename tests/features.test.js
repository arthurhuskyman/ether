// «Слой удовольствия» (js/features.js) и безопасные функции из killer-features-backlog.
const test = require("node:test");
const assert = require("node:assert/strict");
const { bootApp, closeAll } = require("./harness");
test.after(closeAll);
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const click = (a, el) => el.dispatchEvent(new a.window.MouseEvent("click", { bubbles: true }));

async function chatApp(extra = {}) {
  const a = await bootApp(extra);
  a.run(`ensureContactEntry("alice","Алиса"); state.contacts.get("alice").publicKey = {kty:"EC", x:"AAA111", y:"BBB222"};`);
  return a;
}
const openChat = (a, id = "alice") => { a.run(`state.chatId = "${id}"; renderTab();`); };

test("FX: настройки по умолчанию, сохранение в ether.fx, breathing выключен по умолчанию на iOS", async () => {
  const a = await bootApp({});
  assert.equal(a.run(`FX.get("dance")`), true);
  assert.equal(a.run(`FX.get("sonic")`), false);
  assert.equal(a.run(`FX.get("breathing")`), true, "на десктопе дыхание включено по умолчанию");
  a.run(`FX.set("dance", false)`);
  assert.equal(JSON.parse(a.window.localStorage.getItem("ether.fx")).dance, false);
  a.close();
  const ios = await bootApp({ platform: "ios", standalone: true });
  assert.equal(ios.run(`FX.get("breathing")`), false, "на iOS — спокойный режим");
  assert.ok(!ios.document.documentElement.classList.contains("fx-breathing"));
  ios.close();
});

test("Sonic Signature: детерминированный chime из ключа, разные ключи — разные мелодии, звук идёт через WebAudio", async () => {
  const a = await chatApp();
  const n1 = a.run(`JSON.stringify(sonicNotesFor("keyA"))`), n2 = a.run(`JSON.stringify(sonicNotesFor("keyA"))`), n3 = a.run(`JSON.stringify(sonicNotesFor("keyB-other"))`);
  assert.equal(n1, n2); assert.notEqual(n1, n3);
  assert.equal(JSON.parse(n1).length, 3);
  a.run(`Store.soundsEnabled = true; ensureGlobalAudioCtx();`);
  const before = a.window.__audioNodes.filter((n) => n.type === "sine").length;
  a.run(`FX.set("sonic", false); playMessageSound("alice")`);
  const mid = a.window.__audioNodes.filter((n) => n.type === "sine").length;
  a.run(`FX.set("sonic", true); playMessageSound("alice")`);
  const after = a.window.__audioNodes.filter((n) => n.type === "sine").length;
  assert.equal(after - mid, 3, "Sonic Signature: ровно 3 ноты");
  assert.equal(a.run(`playSonicSignature("nope")`), false);
  a.close();
});

test("Personal Sigil: детерминирован, симметричен, зависит от ключа; показывается в карточке контакта и в настройках", async () => {
  const a = await chatApp();
  const s1 = a.run(`sigilSvg("k1", 48)`), s2 = a.run(`sigilSvg("k1", 48)`), s3 = a.run(`sigilSvg("k2", 48)`);
  assert.equal(s1, s2); assert.notEqual(s1, s3);
  assert.match(s1, /<svg[^>]+viewBox="0 0 48 48"/);
  const xs = [...s1.matchAll(/<rect x="(\d+)"/g)].map((m) => +m[1]);
  for (const x of xs) assert.ok(xs.includes(40 - x), "зеркальная пара есть для x=" + x);
  a.run(`state.contactCardId = "alice"; state.chatId = null; renderTab();`);
  assert.ok(a.document.querySelector("#screen-contact #fx-sigil svg"));
  assert.ok(a.document.querySelector("#fx-my-sigil svg"));
  a.close();
});

test("The Vault: кристалл в шапке чата, яркость растёт с числом сообщений", async () => {
  const a = await chatApp();
  assert.ok(a.run(`vaultLevel(0)`) === 0 && a.run(`vaultLevel(9999)`) > 0.9 && a.run(`vaultLevel(10)`) < a.run(`vaultLevel(1000)`));
  a.run(`state.contacts.get("alice").messages.push({id:"1", from:"them", text:"hi", ts: Date.now()-1000})`);
  openChat(a);
  const v = a.document.querySelector("#fx-vault-crystal");
  assert.ok(v, "кристалл показан"); assert.equal(v.title, "1");
  a.run(`FX.set("vault", false)`);
  assert.equal(a.document.querySelector("#fx-vault-crystal"), null);
  a.close();
});

test("Bubble Dance: сообщения в пределах 500 мс (свежие) получают анимацию, старые и далёкие — нет", async () => {
  const a = await chatApp();
  const now = Date.now();
  a.run(`state.contacts.get("alice").messages.push(
    {id:"m1", from:"me", text:"a", ts:${now - 20000}}, {id:"m2", from:"them", text:"b", ts:${now - 19800}},
    {id:"o1", from:"me", text:"old", ts:${now - 900000}}, {id:"o2", from:"them", text:"old2", ts:${now - 899900}});`);
  openChat(a);
  const row = (id) => a.document.querySelector(`[data-msg-id="${id}"]`).closest(".bubble-row");
  assert.ok(!row("m1").classList.contains("fx-dance-mine"), "разница 200мс, но сообщения старше 8 с — не танцуют");
  a.run(`state.contacts.get("alice").messages.push({id:"n1", from:"me", text:"x", ts:Date.now()}, {id:"n2", from:"them", text:"y", ts:Date.now()+200}); renderChatThreadInner();`);
  assert.ok(row("n1").classList.contains("fx-dance-mine"));
  assert.ok(row("n2").classList.contains("fx-dance-theirs"));
  assert.ok(!row("o1").classList.contains("fx-dance-mine"));
  a.close();
});

test("Message Patina: уровни по возрасту и атрибут data-age", async () => {
  const a = await chatApp();
  const day = 86400000, now = Date.now();
  assert.deepEqual(JSON.parse(a.run(`JSON.stringify([patinaLevel(${now}), patinaLevel(${now - 100 * day}), patinaLevel(${now - 400 * day}), patinaLevel(${now - 800 * day})])`)), [0, 1, 2, 3]);
  a.run(`state.contacts.get("alice").messages.push({id:"p1", from:"them", text:"old", ts:${now - 800 * day}}, {id:"p2", from:"them", text:"new", ts:${now}});`);
  openChat(a);
  assert.equal(a.document.querySelector('[data-msg-id="p1"]').getAttribute("data-age"), "3");
  assert.equal(a.document.querySelector('[data-msg-id="p2"]').getAttribute("data-age"), null);
  a.run(`FX.set("patina", false)`);
  assert.equal(a.document.querySelector('[data-msg-id="p1"]').getAttribute("data-age"), null);
  a.close();
});

test("Birthday Sparkle: ДД.ММ, искры на аватаре в день рождения, конфетти при первом поздравлении (раз в год)", async () => {
  const a = await chatApp();
  assert.equal(a.run(`fxParseBirthday("05.10")`), "10-05");
  assert.equal(a.run(`fxParseBirthday("5-1")`), "01-05");
  assert.equal(a.run(`fxParseBirthday("31.13")`), null); assert.equal(a.run(`fxParseBirthday("abc")`), null);
  const d = new Date(), mmdd = String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  a.run(`state.contacts.get("alice").birthday = "${mmdd}"`);
  assert.equal(a.run(`fxIsBirthdayToday(state.contacts.get("alice"))`), true);
  openChat(a);
  assert.ok(a.document.querySelector("#chat-peer-avatar").classList.contains("fx-birthday"));
  a.run(`trySendOrQueue = async () => {}`);
  await a.run(`sendChatMessage("alice", "обычное сообщение")`);
  assert.equal(a.document.querySelector(".fx-confetti"), null);
  await a.run(`sendChatMessage("alice", "С днём рождения! 🎂")`);
  assert.ok(a.document.querySelector(".fx-confetti"), "салют при первом поздравлении");
  a.document.querySelector(".fx-confetti").remove();
  await a.run(`sendChatMessage("alice", "ещё раз поздравляю")`);
  assert.equal(a.document.querySelector(".fx-confetti"), null, "повторно в тот же год — без салюта");
  // поле в карточке контакта сохраняет дату
  a.run(`state.chatId = null; state.contactCardId = "alice"; renderTab();`);
  const inp = a.document.querySelector("#fx-birthday");
  inp.value = "07.03"; inp.dispatchEvent(new a.window.Event("change", { bubbles: true }));
  assert.equal(a.run(`state.contacts.get("alice").birthday`), "03-07");
  inp.value = "xx"; inp.dispatchEvent(new a.window.Event("change", { bubbles: true }));
  assert.equal(a.run(`state.contacts.get("alice").birthday`), "03-07", "неверный формат не затирает дату");
  a.run(`persistContactsNow && persistContacts(); persistContactsNow(); state.contacts.clear(); loadContacts();`);
  assert.equal(a.run(`state.contacts.get("alice").birthday`), "03-07", "день рождения переживает перезагрузку");
  a.close();
});

test("Easter eggs: тройной тап по пустому месту → звёздный дождь; 🚀 → ракета; выключается настройкой", async () => {
  const a = await chatApp();
  openChat(a);
  const wrap = a.document.querySelector("#chat-messages");
  for (let i = 0; i < 3; i++) click(a, wrap);
  assert.ok(a.document.querySelector(".fx-starfall"));
  a.document.querySelector(".fx-starfall").remove();
  a.run(`trySendOrQueue = async () => {}`);
  await a.run(`sendChatMessage("alice", "поехали 🚀")`);
  assert.ok(a.document.querySelector(".fx-rocket"));
  a.document.querySelector(".fx-rocket").remove();
  a.run(`FX.set("easter", false)`);
  for (let i = 0; i < 3; i++) click(a, wrap);
  assert.equal(a.document.querySelector(".fx-starfall"), null);
  // клик по пузырю не считается «пустым местом»
  a.close();
});

test("Farewell Fade: при удалении контакта — прощальная строка с числом сообщений и сроком", async () => {
  const a = await chatApp();
  const old = Date.now() - 800 * 86400000;
  a.run(`state.contacts.get("alice").messages.push({id:"1", from:"them", text:"x", ts:${old}}, {id:"2", from:"me", text:"y", ts:${Date.now()}}); mesh = { remove() {}, get() { return null; } };`);
  a.run(`deleteContact("alice")`);
  const t = a.document.querySelector("#toast").textContent;
  assert.match(t, /Алиса/); assert.match(t, /2/); assert.match(t, /2 л\.|2 y\./);
  assert.ok(a.document.querySelector("#app-shell").classList.contains("fx-farewell"));
  assert.equal(a.run(`state.contacts.has("alice")`), false);
  a.close();
});

test("Aesthetic of silence: в пустом чате — живая сцена, тап по огню запускает анимацию", async () => {
  const a = await chatApp();
  openChat(a);
  const scene = a.document.querySelector("#chat-messages .fx-scene");
  assert.ok(scene);
  scene.click();
  assert.ok(scene.classList.contains("fx-poke"));
  a.run(`FX.set("silence", false); state.chatId=null; renderTab(); state.chatId="alice"; renderTab();`);
  assert.equal(a.document.querySelector("#chat-messages .fx-scene"), null);
  a.close();
});

test("Ритуал дня: не показывается при самом первом открытии, показывается при новом дне", async () => {
  const a = await bootApp({ storage: { "ether.fx.lastOpen": new Date(Date.now() - 2 * 86400000).toDateString() } });
  await tick(30);
  assert.ok(a.document.querySelector(".fx-ritual"), "новый день → приветствие");
  assert.match(a.document.querySelector(".fx-ritual").textContent, /Доброе утро|Добрый день|Добрый вечер|Доброй ночи|Good/);
  a.close();
  const first = await bootApp({});
  await tick(30);
  assert.equal(first.document.querySelector(".fx-ritual"), null, "первое открытие — без ритуала");
  first.close();
});

test("Ether Breathing / Seasonal / Soft skin: классы и CSS-переменные, пауза при скрытии, учёт Low Power", async () => {
  const a = await chatApp();
  const root = a.document.documentElement;
  assert.ok(root.classList.contains("fx-breathing") && root.classList.contains("fx-season"));
  const hue = parseFloat(root.style.getPropertyValue("--fx-season-hue"));
  assert.ok(Math.abs(hue) <= 28);
  assert.ok(Math.abs(a.run(`seasonHue("2026-12-21")`)) <= 28 && a.run(`seasonHue("2026-03-21")`) !== a.run(`seasonHue("2026-09-21")`));
  const h = a.run(`skinHue(state.contacts.get("alice"))`);
  assert.ok(h >= -25 && h <= 25);
  assert.equal(a.run(`skinHue(state.contacts.get("alice"))`), h);
  openChat(a);
  assert.ok(root.classList.contains("fx-chat-open"));
  assert.ok(root.style.getPropertyValue("--breath-s"));
  a.run(`FX.set("skin", true)`);
  assert.ok(root.classList.contains("fx-skin"));
  a.run(`FX.set("breathing", false)`);
  assert.ok(!root.classList.contains("fx-breathing"));
  Object.defineProperty(a.document, "hidden", { value: true, configurable: true });
  a.document.dispatchEvent(new a.window.Event("visibilitychange"));
  assert.ok(root.classList.contains("fx-paused"));
  a.close();
});

test("Голосовые: стиль кассета/пластинка через data-атрибут; анимация только во время воспроизведения", async () => {
  const a = await chatApp();
  a.run(`FX.set("voiceStyle", "cassette")`);
  assert.equal(a.document.documentElement.getAttribute("data-voice-style"), "cassette");
  a.run(`state.contacts.get("alice").messages.push({id:"v1", from:"them", text:"", ts:Date.now(), file:{name:"v.webm", mime:"audio/webm", size:10, kind:"audio", duration:3}});`);
  openChat(a);
  const bubble = a.document.querySelector(".voice-bubble");
  if (bubble) {
    const btn = bubble.querySelector(".voice-play-btn");
    btn.innerHTML = a.run(`VOICE_PAUSE_ICON_SVG`); await tick(20);
    assert.ok(bubble.classList.contains("fx-playing"));
    btn.innerHTML = a.run(`VOICE_PLAY_ICON_SVG`); await tick(20);
    assert.ok(!bubble.classList.contains("fx-playing"));
  }
  a.close();
});

test("Сгорание: fade/пепел анимируют исчезающее сообщение и затем удаляют; без дымного следа", async () => {
  const a = await chatApp();
  a.run(`FX.set("burn", "ash"); state.contacts.get("alice").messages.push({id:"b1", from:"them", text:"секрет", ts:Date.now(), ttl:60000});`);
  openChat(a);
  a.run(`state.contacts.get("alice").messages[0].ts = Date.now() - 120000; sweepExpiredMessages()`);
  const row = a.document.querySelector('[data-msg-id="b1"]').closest(".bubble-row");
  assert.ok(row.classList.contains("fx-burn-ash"));
  assert.ok(a.document.querySelectorAll(".fx-ash").length > 0);
  assert.doesNotMatch(a.document.documentElement.outerHTML, /fx-smoke/);
  await tick(1000);
  assert.equal(a.run(`state.contacts.get("alice").messages.length`), 0);
  a.run(`FX.set("burn", "off"); state.contacts.get("alice").messages.push({id:"b2", from:"them", text:"x", ts:Date.now()-5000, ttl:1000}); sweepExpiredMessages()`);
  assert.equal(a.run(`state.contacts.get("alice").messages.length`), 0, "при выключенном эффекте удаление мгновенное");
  a.close();
});

test("Реакции: мини-стек аватаров (до 3) и число", async () => {
  const a = await chatApp();
  a.run(`ensureContactEntry("bob","Боб"); state.contacts.get("alice").messages.push({id:"r1", from:"them", text:"hi", ts:Date.now(), reactions:{"👍":["alice","bob", Store.myId, "x"]}});`);
  openChat(a);
  const chip = a.document.querySelector(".bubble-reaction-chip");
  assert.equal(chip.querySelectorAll(".fx-av").length, 3);
  assert.match(chip.textContent, /4$/);
  a.close();
});

test("Итоги года: подсчёт только локально — отправлено/получено, топ контактов, эмодзи, час, самая долгая пауза", async () => {
  const a = await chatApp();
  const y = new Date().getFullYear(), at = (mo, d, h) => new Date(y, mo, d, h).getTime();
  a.run(`ensureContactEntry("bob","Боб");
    state.contacts.get("alice").messages.push({id:"1", from:"me", text:"привет 😀😀", ts:${at(0, 1, 10)}}, {id:"2", from:"them", text:"привет", ts:${at(0, 2, 10)}}, {id:"3", from:"me", text:"давно 🎉", ts:${at(0, 12, 22)}});
    state.contacts.get("bob").messages.push({id:"4", from:"them", text:"yo", ts:${at(1, 1, 10)}});
    state.contacts.get("alice").messages.push({id:"old", from:"me", text:"прошлый год", ts:${new Date(y - 1, 5, 5).getTime()}});`);
  const w = JSON.parse(a.run(`JSON.stringify(computeWrapped(${y}))`));
  assert.equal(w.sent, 2); assert.equal(w.received, 2); assert.equal(w.total, 4);
  assert.equal(w.top[0].name, "Алиса"); assert.equal(w.top[0].count, 3);
  assert.equal(w.topEmoji, "😀"); assert.equal(w.peakHour, 10);
  assert.equal(w.longestPauseDays, 10.5);
  const ov = a.run(`openYearlyWrapped()`);
  assert.ok(a.document.querySelector(".fx-wrapped"));
  for (let i = 0; i < 6; i++) click(a, a.document.querySelector(".fx-wrapped") || a.document.body);
  assert.equal(a.document.querySelector(".fx-wrapped"), null, "после последнего слайда закрывается");
  a.close();
});

test("Постер переписки: PNG собирается из имени, периода, числа сообщений и фраз; скачивается", async () => {
  const a = await chatApp();
  a.run(`state.contacts.get("alice").messages.push({id:"1", from:"me", text:"Это длинная красивая фраза для постера", ts:Date.now()-86400000}, {id:"2", from:"them", text:"И ещё одна хорошая фраза тут", ts:Date.now()});`);
  assert.equal(a.run(`posterPhrases(state.contacts.get("alice"), 4).length`), 2);
  let saved = null;
  a.window.__dl = (b, n) => { saved = n; };
  a.run(`downloadBlob = window.__dl;`);
  const blob = await a.run(`exportConversationPoster("alice")`);
  assert.ok(blob);
  assert.match(saved, /^ether-poster-.*\.png$/);
  a.close();
});

test("Экспорт с подписью: ECDSA + hash-chain; подпись валидна, любая правка (текст, порядок, метаданные, подпись) ломает проверку", async () => {
  const a = await chatApp();
  a.run(`state.contacts.get("alice").messages.push({id:"1", from:"me", text:"первое", ts:1000}, {id:"2", from:"them", text:"второе", ts:2000}, {id:"3", from:"me", text:"третье", ts:3000});`);
  const data = await a.run(`buildSignedExport("alice")`);
  const clone = () => JSON.parse(JSON.stringify(data));
  a.window.__d = clone();
  let r = await a.run(`verifySignedExport(window.__d)`);
  assert.deepEqual({ ok: r.ok }, { ok: true });
  assert.equal(data.messages.length, 3); assert.equal(data.chain.length, 3);
  const bad = async (mut, reason) => { const d = clone(); mut(d); a.window.__d = d; const x = await a.run(`verifySignedExport(window.__d)`); assert.equal(x.ok, false, reason); };
  await bad((d) => { d.messages[1].text = "подделка"; }, "изменён текст");
  await bad((d) => { [d.messages[0], d.messages[1]] = [d.messages[1], d.messages[0]]; }, "переставлены сообщения");
  await bad((d) => { d.messages.pop(); d.chain.pop(); }, "удалено сообщение (count)");
  await bad((d) => { d.meta.peerName = "Другой"; }, "изменены метаданные");
  await bad((d) => { d.signature = "00" + d.signature.slice(2); }, "испорчена подпись");
  await bad((d) => { d.format = "x"; }, "не тот формат");
  // ключ подписи создаётся один раз и переиспользуется
  const k1 = a.window.localStorage.getItem("ether.sigKey");
  await a.run(`buildSignedExport("alice")`);
  assert.equal(a.window.localStorage.getItem("ether.sigKey"), k1);
  // кнопки в карточке контакта и в настройках
  a.run(`state.chatId = null; state.contactCardId = "alice"; renderTab();`);
  assert.ok(a.document.querySelector("#fx-export-signed")); assert.ok(a.document.querySelector("#fx-export-poster"));
  assert.ok(a.document.querySelector("#fx-verify-btn"));
  a.close();
});

test("Резервная копия включает настройки эффектов и ключ подписи", async () => {
  const a = await bootApp({});
  const keys = a.run(`JSON.stringify(CRITICAL_LS_KEYS)`);
  assert.match(keys, /ether\.fx/); assert.match(keys, /ether\.sigKey/);
  a.close();
});

test("Настройки → Оформление → «Эффекты»: все переключатели работают и пишутся в хранилище", async () => {
  const a = await bootApp({});
  const grp = a.document.querySelector("#fx-settings-group");
  assert.ok(grp); assert.equal(grp.getAttribute("data-settings-category"), "appearance");
  for (const k of ["sonic", "dance", "vault", "patina", "easter", "farewell", "silence", "ritual", "breathing", "season", "skin", "sigil"]) {
    const el = grp.querySelector("#fxs-" + k); assert.ok(el, k);
    el.checked = !el.checked; el.dispatchEvent(new a.window.Event("change", { bubbles: true }));
    assert.equal(a.run(`FX.get("${k === "sigil" ? "sigil" : k}")`), el.checked, k);
  }
  const burn = grp.querySelector("#fxs-burn"); burn.value = "fade"; burn.dispatchEvent(new a.window.Event("change", { bubbles: true }));
  assert.equal(a.run(`FX.get("burn")`), "fade");
  a.close();
});
