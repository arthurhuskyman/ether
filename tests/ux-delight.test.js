// V.80 удобство: редактор темы (контраст, импорт/экспорт, безопасность), десктопный макет, горячие клавиши,
// приглашение из контактов (Contact Picker), онбординг, доступность звонка.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closeAll } = require("./harness");
test.after(closeAll);
async function booted(extra) {
  const a = createApp({ storage: Object.assign({ "ether.name": "T", "ether.myId": "me-test-id", "ether.lang": "en", "ether.uiMode": "full" }, extra || {}) });
  await a.ready;
  for (let i = 0; i < 60 && !a.run(`typeof __appStarted !== "undefined" && __appStarted`); i++) await new Promise((r) => setTimeout(r, 50));
  a.run(`ensureContactEntry("alice", "Alice").managed = true; ensureContactEntry("bob", "Bob").managed = true; ensureContactEntry("carol", "Carol").managed = true; state.tab = "chats"; renderTab();`);
  return a;
}
const J = (a, code) => JSON.parse(a.run(`JSON.stringify(${code})`));

test("тема: hex-проверка, sanitize отбрасывает всё лишнее, в CSS попадают только hex", async () => {
  const a = await booted();
  assert.equal(a.run(`ThemeEditor.hex("#ABC")`), "#aabbcc");
  assert.equal(a.run(`ThemeEditor.hex("red; background:url(x)")`), null);
  assert.equal(a.run(`ThemeEditor.sanitize({accent:"#fff",bg:"url(x)",mine:"#000",theirs:"#111"})`), null);
  const t = J(a, `ThemeEditor.sanitize({accent:"#123456",bg:"#ffffff",mine:"#654321",theirs:"#eeeeee",radius:"evil",x:1})`);
  assert.deepEqual(Object.keys(t).sort(), ["accent", "bg", "mine", "radius", "theirs", "v"]);
  assert.equal(t.radius, "normal");
  const v = J(a, `ThemeEditor.vars(${JSON.stringify(t)})`);
  for (const val of Object.values(v)) assert.match(val, /^(#[0-9a-f]{6}|rgba\(\d+,\d+,\d+,0\.12\)|\d+px)$/);
  a.close();
});

test("тема: низкий контраст отклоняется проверкой и чинится, текст всегда >= 4.5", async () => {
  const a = await booted();
  const bad = { accent: "#f0f0f0", bg: "#ffffff", mine: "#777777", theirs: "#787878", radius: "pill" };
  const checks = J(a, `ThemeEditor.validate(${JSON.stringify(bad)})`);
  assert.ok(checks.some((c) => c.id === "accent" && !c.ok), "светлый акцент на белом — плохо");
  assert.ok(checks.some((c) => c.id === "bubbles" && !c.ok), "пузыри сливаются");
  const f = J(a, `ThemeEditor.fix(${JSON.stringify(bad)})`);
  assert.ok(f.changed.includes("accent"));
  assert.ok(J(a, `ThemeEditor.validate(${JSON.stringify(f.theme)})`).every((c) => c.ok), "после исправления всё в норме");
  // любой фон, включая «средние» серые: авто-текст читается
  for (const bg of ["#808080", "#767676", "#777777", "#ff0000", "#00aa00", "#0000ff"]) {
    const ch = J(a, `ThemeEditor.validate({accent:"#000000",bg:"${bg}",mine:"${bg}",theirs:"${bg}"})`);
    for (const id of ["text", "mine", "theirs"]) assert.ok(ch.find((c) => c.id === id).ratio >= 4.5, bg + " " + id);
  }
  a.close();
});

test("тема: экспорт/импорт JSON, мусор и большой ввод отклоняются", async () => {
  const a = await booted();
  const th = { accent: "#1a5fb4", bg: "#101418", mine: "#1a5fb4", theirs: "#232a31", radius: "round" };
  const json = a.run(`ThemeEditor.exportJson(${JSON.stringify(th)})`);
  assert.equal(JSON.parse(json).ether, "theme");
  const back = J(a, `ThemeEditor.importJson(${JSON.stringify(json)})`);
  assert.equal(back.accent, th.accent); assert.equal(back.radius, "round");
  for (const bad of ["{}", "не json", '{"ether":"other"}', '{"ether":"theme","accent":"#fff"}', "x".repeat(2500)]) assert.equal(a.run(`ThemeEditor.importJson(${JSON.stringify(bad)})`), null);
  a.close();
});

test("тема: сохранение применяет переменные и тянется после перезагрузки; готовый скин снимает её", async () => {
  const a = await booted();
  const r = J(a, `ThemeEditor.save({accent:"#f5f5f5",bg:"#ffffff",mine:"#2255aa",theirs:"#eeeeee",radius:"sharp"})`);
  assert.ok(r.changed.includes("accent"), "автоисправление при сохранении");
  const root = a.document.documentElement;
  assert.equal(root.getAttribute("data-custom-theme"), "1");
  assert.equal(root.style.getPropertyValue("--r-md"), "5px");
  assert.equal(root.style.getPropertyValue("--bg-0"), "#ffffff");
  assert.ok(a.run(`localStorage.getItem("ether.customTheme")`));
  a.run(`Skins.set("sakura")`);
  assert.equal(root.getAttribute("data-custom-theme"), null);
  assert.equal(root.style.getPropertyValue("--bg-0"), "");
  assert.equal(a.run(`localStorage.getItem("ether.customTheme")`), null);
  a.close();
  const b = await booted({ "ether.customTheme": JSON.stringify({ v: 1, accent: "#0a4d8c", bg: "#ffffff", mine: "#0a4d8c", theirs: "#e6e6e6", radius: "pill" }) });
  b.run(`Skins.wire()`);
  assert.equal(b.document.documentElement.getAttribute("data-custom-theme"), "1");
  b.close();
});

test("тема: шторка редактора открывается из «Все скины», кнопки работают, id уникальны", async () => {
  const a = await booted(), d = a.document;
  a.run(`Skins.openSheet()`);
  d.querySelector("#theme-editor-open").click();
  assert.ok(!d.querySelector("#theme-editor-sheet").classList.contains("hidden"));
  assert.ok(d.querySelector("#skin-sheet").classList.contains("hidden"));
  const set = (id, v) => { const el = d.getElementById(id); el.value = v; el.dispatchEvent(new a.window.Event("input", { bubbles: true })); };
  set("te-bg", "#ffffff"); set("te-accent", "#fafafa");
  assert.match(d.querySelector("#theme-editor-checks").textContent, /✗ Accent on background/);
  d.querySelector("#te-fix").click();
  assert.doesNotMatch(d.querySelector("#theme-editor-checks").textContent, /✗/);
  d.querySelector("#te-export").click();
  assert.equal(JSON.parse(d.querySelector("#te-json").value).ether, "theme");
  d.querySelector("#te-json").value = "oops"; d.querySelector("#te-import").click();
  assert.equal(d.querySelector("#theme-editor-note").textContent, "This is not a valid theme");
  d.querySelector("#te-save").click();
  assert.equal(d.documentElement.getAttribute("data-custom-theme"), "1");
  const ids = Array.from(d.querySelectorAll("[id]")).map((e) => e.id);
  assert.deepEqual(ids.filter((x, i) => ids.indexOf(x) !== i), []);
  a.close();
});

test("десктопный макет: >=1100px — список слева, чат, панель контакта; на мобильном ничего не меняется", async () => {
  const a = await booted(), d = a.document, root = d.documentElement;
  a.run(`state.chatId = "alice"; renderTab();`);
  assert.ok(!root.classList.contains("wide") && d.querySelector("#screen-chats").classList.contains("hidden"), "узкий экран: только чат");
  a.run(`__wideMq = { matches: true }; renderTab();`);
  assert.ok(root.classList.contains("wide") && root.classList.contains("wide-chat"));
  assert.ok(!d.querySelector("#screen-chats").classList.contains("hidden"), "список виден рядом с чатом");
  assert.ok(!d.querySelector("#screen-chat").classList.contains("hidden"));
  assert.ok(!d.querySelector("#wide-info").classList.contains("hidden"));
  assert.match(d.querySelector("#wide-info").textContent, /Alice/);
  const rows = Array.from(d.querySelectorAll("#chats-list .chat-row"));
  assert.ok(rows.length >= 3);
  assert.equal(rows.filter((r) => r.getAttribute("aria-current") === "true").map((r) => r.dataset.chatId).join(), "alice");
  a.run(`state.chatId = null; renderTab();`);
  assert.ok(!root.classList.contains("wide-chat"));
  assert.ok(!d.querySelector("#wide-empty").classList.contains("hidden"), "заглушка вместо пустой правой части");
  assert.ok(d.querySelector("#wide-info").classList.contains("hidden"));
  a.run(`__wideMq = { matches: false }; renderTab();`);
  assert.ok(!root.classList.contains("wide") && d.querySelector("#wide-empty").classList.contains("hidden"));
  a.close();
});

test("горячие клавиши: Ctrl+F, Alt+↑/↓, Esc; Ctrl+K открывает только палитру", async () => {
  const a = await booted(), d = a.document, w = a.window;
  const key = (o) => { const e = new w.KeyboardEvent("keydown", Object.assign({ bubbles: true, cancelable: true }, o)); d.dispatchEvent(e); return e; };
  a.run(`__wideMq = { matches: true }; state.chatId = "alice"; renderTab();`);
  assert.ok(key({ key: "f", ctrlKey: true }).defaultPrevented);
  assert.ok(!d.querySelector("#chat-search-bar").classList.contains("hidden"), "поиск в чате");
  key({ key: "Escape" });
  assert.ok(d.querySelector("#chat-search-bar").classList.contains("hidden"));
  assert.equal(a.run(`state.chatId`), "alice", "первый Esc закрыл только поиск");
  const order = Array.from(d.querySelectorAll("#chats-list .chat-row")).map((r) => r.dataset.chatId);
  const i = order.indexOf("alice");
  key({ key: "ArrowDown", altKey: true });
  assert.equal(a.run(`state.chatId`), order[(i + 1) % order.length]);
  key({ key: "ArrowUp", altKey: true });
  assert.equal(a.run(`state.chatId`), "alice");
  key({ key: "Escape" });
  assert.equal(a.run(`state.chatId`), null, "Esc закрывает чат в широком режиме");
  key({ key: "k", ctrlKey: true });
  assert.ok(!d.querySelector("#cmdk").classList.contains("hidden"));
  assert.ok(d.querySelector("#global-search-sheet") === null || d.querySelector("#global-search-sheet").classList.contains("hidden"), "общий поиск не открылся поверх");
  // шторка открыта — Alt+↓ не переключает чат
  a.run(`closeCmdk(); state.chatId = "alice"; renderTab(); $("#cmdk").classList.remove("hidden");`);
  key({ key: "ArrowDown", altKey: true });
  assert.equal(a.run(`state.chatId`), "alice");
  a.close();
});

test("приглашение из контактов: ссылки sms/почта, очистка ввода, честная заметка, кнопки скрыты без Contact Picker", async () => {
  const a = await booted(), d = a.document;
  assert.ok(d.querySelector("#connect-pick-contacts-btn").classList.contains("hidden"), "нет navigator.contacts — кнопки нет");
  const l = J(a, `buildInviteLinks({ name: ["Мама"], tel: ["+7 (999) 123-45-67", "12"], email: ["bad", "m@ex.org"] }, "https://x.test/#add=1", "Join me")`);
  assert.equal(l.length, 2);
  assert.match(l[0].href, /^sms:\+79991234567\?body=Join%20me%20https%3A%2F%2Fx\.test/);
  assert.match(l[1].href, /^mailto:m@ex\.org\?subject=/);
  assert.deepEqual(J(a, `buildInviteLinks({ tel: ["1"], email: ["a b@c"] }, "L", "")`), []);
  assert.deepEqual(J(a, `buildInviteLinks({ tel: ["+1 555 123 4567;rm"] }, "L", "").map(x=>x.href.split("?")[0])`), ["sms:+15551234567"]);
  // с поддержкой: выбор показывает только тех, кого есть чем пригласить
  a.run(`navigator.contacts = { select: async () => [{ name: ["Ann"], tel: ["+49 170 1234567"] }, { name: ["NoWay"], tel: [], email: [] }] }; wireInviteContacts();`);
  assert.ok(!d.querySelector("#connect-pick-contacts-btn").classList.contains("hidden"));
  await a.run(`pickContactsToInvite()`);
  const rows = d.querySelectorAll("#invite-contacts-list .invite-contact-row");
  assert.equal(rows.length, 1);
  assert.match(rows[0].textContent, /Ann/);
  assert.ok(!d.querySelector("#invite-contacts-sheet").classList.contains("hidden"));
  assert.match(d.querySelector("#invite-contacts-sheet").textContent, /not uploaded/);
  a.close();
});

test("онбординг: сетка языков спрятана, имя в фокусе, три шага до приглашения", async () => {
  const a = createApp({ storage: { "ether.lang": "en" } });
  await a.ready;
  const d = a.document;
  await new Promise((r) => setTimeout(r, 300));
  a.run(`wireOnboardingOnce()`);
  assert.ok(d.querySelector("#onboarding-lang-more").classList.contains("hidden"), "язык определён сам — сетка за одной строкой");
  assert.match(d.querySelector("#onboarding-lang-toggle").textContent, /English · change language/);
  d.querySelector("#onboarding-lang-toggle").click();
  assert.ok(!d.querySelector("#onboarding-lang-more").classList.contains("hidden"));
  assert.equal(d.querySelector("#onboarding-lang-toggle").getAttribute("aria-expanded"), "true");
  d.querySelector('.onboarding-slide[data-slide="0"] .onboarding-next').click(); // тап 1
  assert.ok(!d.querySelector('.onboarding-slide[data-slide="1"]').classList.contains("hidden"));
  d.querySelector("#onboarding-name").value = "Ann";
  d.querySelector("#onboarding-form").dispatchEvent(new a.window.Event("submit", { cancelable: true, bubbles: true })); // тап 2
  for (let i = 0; i < 40 && d.querySelector('.onboarding-slide[data-slide="2"]').classList.contains("hidden"); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(!d.querySelector('.onboarding-slide[data-slide="2"]').classList.contains("hidden"), "после имени сразу ссылка и QR");
  assert.ok(d.querySelector("#onboarding-invite-btn"), "тап 3 — «Пригласить друга»");
  a.close();
});

test("доступность звонка: озвучка фазы, aria-pressed у переключателей, подписи у значков", async () => {
  const a = await booted(), d = a.document;
  a.run(`wireCallA11y()`);
  const mute = d.querySelector("#call-mute-btn");
  assert.equal(mute.getAttribute("aria-pressed"), "false");
  mute.classList.add("active");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(mute.getAttribute("aria-pressed"), "true");
  d.querySelector("#call-peer-name").textContent = "Alice";
  d.querySelector("#call-phase").textContent = "Incoming call";
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(d.querySelector("#sr-announcer").textContent, "Alice: Incoming call");
  d.querySelector("#call-phase").textContent = "00:07";
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(d.querySelector("#sr-announcer").textContent, "Alice: Incoming call", "секундомер не озвучивается");
  // каждая кнопка без текста имеет доступное имя
  const nameless = Array.from(d.querySelectorAll("#call-screen button, #nav-bar button, #tab-bar button")).filter((b) => b.id !== "call-notice" && !b.textContent.trim() && !b.getAttribute("aria-label") && !b.getAttribute("aria-labelledby") && !b.title);
  assert.deepEqual(nameless.map((b) => b.id), []);
  a.close();
});
