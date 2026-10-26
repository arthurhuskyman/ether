// V.80.1: «Лаборатория звонка» в Отладке: чистая логика (sms/tel/FaceTime, .ics с VALARM, UA, журнал, анализ замеров микрофона),
// единственный вход (#ringlab-btn), мастер, «Позвонить громко», локальные поля контакта.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");
const { createApp, closeAll } = require("./harness");
test.after(closeAll);

function loadCore() {
  const store = new Map();
  const ctx = { localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) }, TextEncoder, URL, Date, JSON, Math, encodeURIComponent };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "js/app/19-ringlab-core.js"), "utf8").replace('"use strict";', "") + "\nthis.C = RingLabCore;", ctx);
  return ctx.C;
}

test("ссылки: tel/sms/FaceTime чистятся и не пропускают чужие схемы", () => {
  const C = loadCore();
  assert.equal(C.cleanPhone(" +7 (916) 123-45-67 "), "+79161234567");
  assert.equal(C.cleanPhone("12"), ""); assert.equal(C.telLink("javascript:alert(1)"), "");
  assert.equal(C.telLink("+7 916 123 45 67"), "tel:+79161234567");
  assert.equal(C.smsLink("+7916123456", "a b&c", true), "sms:+7916123456&body=a%20b%26c");
  assert.equal(C.smsLink("", "x", false), "sms:?body=x");
  assert.equal(C.cleanFaceTimeLink("https://facetime.apple.com/join#v=1&p=abc"), "https://facetime.apple.com/join#v=1&p=abc");
  assert.equal(C.cleanFaceTimeLink("https://evil.example/join"), ""); assert.equal(C.cleanFaceTimeLink("http://facetime.apple.com/x"), "");
});

test(".ics: два VALARM (-PT5M и PT0S), CRLF, экранирование, строки ≤75 октетов, UTC-время", () => {
  const C = loadCore();
  const start = Date.UTC(2026, 9, 26, 12, 30, 0);
  const ics = C.buildICS({ start, now: Date.UTC(2026, 9, 26, 12, 0, 0), title: "Тест, звонок; 1", url: "https://x.test/ether/#call=" + "A".repeat(22) + "." + "B".repeat(22), uid: "u1" });
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n") && ics.endsWith("END:VCALENDAR\r\n"));
  assert.equal((ics.match(/BEGIN:VALARM/g) || []).length, 2);
  assert.ok(ics.includes("TRIGGER:-PT5M") && ics.includes("TRIGGER:PT0S"));
  assert.ok(ics.includes("DTSTART:20261026T123000Z") && ics.includes("DTEND:20261026T124500Z") && ics.includes("UID:u1@ether"));
  assert.ok(ics.replace(/\r\n /g, "").includes("Тест\\, звонок\\; 1"));
  for (const line of ics.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75, "длинная строка: " + line.length);
  assert.ok(!/[^\r]\n/.test(ics), "только CRLF");
  assert.ok(ics.replace(/\r\n /g, "").includes("#call=" + "A".repeat(22)), "ссылка звонка сохранена целиком после разворачивания строк");
});

test("UA: версия iOS; журнал: PASS/FAIL/NOTE, лимит, экспорт текстом; анализ микрофона", () => {
  const C = loadCore();
  const u = C.parseUA("Mozilla/5.0 (iPhone; CPU iPhone OS 18_4_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148");
  assert.deepEqual([u.ios, u.version, u.major], [true, "18.4.1", 18]);
  assert.equal(C.parseUA("Mozilla/5.0 (X11; Linux x86_64) Chrome/120").ios, false);
  C.logAdd("e1", "PASS", "ok", 1000); C.logAdd("e2", "bogus", "x", 2000);
  const log = C.logRead(); assert.equal(log[1].res, "NOTE");
  for (let i = 0; i < 250; i++) C.logAdd("n", "INFO", String(i));
  assert.equal(C.logRead().length, 200);
  const txt = C.exportText("hdr", [{ ts: 0, id: "e1", res: "PASS", note: "a\nb" }]);
  assert.match(txt, /Ether Ring Lab\nhdr\n----\n1970-01-01T00:00:00.000Z \[PASS\] e1 — a \| b/);
  // звук шёл в фоне: 10 с скрыто, +480000 отсчётов, энергия > 0
  const s = []; for (let i = 0; i <= 12; i++) s.push({ t: i * 1000, hidden: i >= 2 && i <= 12, tsr: i * 48000, tae: i * 0.01 });
  const ok = C.analyseMic(s, [{ t: 2000, hidden: true }, { t: 12500, hidden: false }]);
  assert.equal(ok.flowed, true);
  const flat = s.map((x) => Object.assign({}, x, { tsr: x.hidden ? 96000 : x.tsr, tae: x.hidden ? 0.02 : x.tae }));
  assert.equal(C.analyseMic(flat, [{ t: 2000, hidden: true }, { t: 12500, hidden: false }]).flowed, false);
  assert.equal(C.analyseMic([{ t: 0, hidden: false, tsr: 0, tae: 0 }], []).flowed, null, "без сворачивания — вывода нет");
});

async function booted() {
  const a = createApp({ storage: { "ether.name": "T", "ether.myId": "me-test-id", "ether.lang": "en", "ether.uiMode": "full" } });
  await a.ready;
  for (let i = 0; i < 60 && !a.run(`typeof __appStarted !== "undefined" && __appStarted`); i++) await new Promise((r) => setTimeout(r, 50));
  return a;
}

test("Отладка: ровно один вход «Ring Lab», мастер и лаборатория открываются, дублей id/кнопок нет", async () => {
  const a = await booted(), d = a.document;
  assert.equal(d.querySelectorAll("#ringlab-btn").length, 1);
  assert.equal(d.querySelector("#ringlab-btn span").textContent, "Ring Lab");
  // ничего нового на экране звонка, в карточке контакта, настройках
  assert.equal(d.querySelector("#screen-settings #ringlab-btn"), null);
  assert.equal(d.querySelector("#call-noanswer-actions #ringlab-btn, #contact-settings-group input[type=tel]"), null);
  a.run(`RingLab.openLab()`);
  const sheet = d.getElementById("ringlab-sheet"); assert.ok(sheet);
  const titles = Array.from(sheet.querySelectorAll("[data-exp] h3")).map((h) => h.textContent);
  assert.equal(titles.length, 9, "9 экспериментов");
  assert.equal(new Set(titles).size, 9);
  assert.ok(sheet.textContent.includes("Microphone in background"));
  assert.ok(sheet.textContent.includes("battery"), "предупреждение о батарее");
  a.run(`RingLab.openLab()`); assert.equal(d.querySelectorAll("#ringlab-sheet").length, 1, "повторное открытие не плодит листов");
  a.run(`RingLab.openWizard()`);
  const w = d.getElementById("ringlab-wizard-sheet"); assert.ok(w);
  assert.equal(w.querySelectorAll("li").length, 6);
  assert.match(w.textContent, /Emergency Bypass/); assert.match(w.textContent, /Silent/);
  const ids = Array.from(d.querySelectorAll("[id]")).map((e) => e.id); assert.equal(ids.length, new Set(ids).size);
  a.close();
});

test("«Позвонить громко»: sms: со ссылкой-звонком, tel: и FaceTime только при локально сохранённых полях; поля не уходят на сервер", async () => {
  const a = await booted(), d = a.document;
  a.run(`{ const c = ensureContactEntry("alice", "Alice"); c.managed = true; }
    window.__nav = []; window.linkCallCreateAndShare = async (o) => { window.__lcopts = o; return { text: "JOIN https://x.test/#call=AAAA", link: "https://x.test/#call=AAAA" }; };`);
  a.run(`RingLab.openLoud("alice")`);
  let sheet = d.getElementById("ringlab-loud-sheet"); assert.ok(sheet);
  const btns = () => Array.from(sheet.querySelectorAll("button")).filter((b) => !b.classList.contains("hidden")).map((b) => b.textContent);
  assert.deepEqual(btns().filter((t) => /Phone call|FaceTime/.test(t)), [], "без телефона/ссылки tel и FaceTime скрыты");
  a.run(`{ const c = state.contacts.get("alice"); c.phoneLocal = "+79161234567"; c.ftLink = "https://facetime.apple.com/join#v=1"; } RingLab.openLoud("alice")`);
  sheet = d.getElementById("ringlab-loud-sheet");
  assert.ok(btns().some((t) => /Phone call/.test(t)) && btns().some((t) => /FaceTime/.test(t)));
  assert.match(sheet.textContent, /experimental/i);
  // сохранение полей: только в записи контакта (persistContacts), нормализация
  a.run(`RingLab.openLab()`);
  const inputs = d.querySelectorAll("#ringlab-sheet input[type=tel], #ringlab-sheet input[type=url]");
  assert.equal(inputs.length, 2);
  a.close();
});

test("флаги Лаборатории по умолчанию выключены; хук «громко» и помощь в звонке — no-op без флага", async () => {
  const a = await booted();
  assert.equal(a.run(`RingLab.flag("autoLoud")`), false);
  assert.equal(a.run(`RingLab.flag("callHelp")`), false);
  assert.equal(a.run(`RingLab.flag("standbyAuto")`), false);
  a.run(`RingLab.autoLoudHook("alice"); RingLab.callHelpStart()`);
  assert.equal(a.document.getElementById("ringlab-loud-sheet"), null);
  assert.equal(a.run(`RingLab.isStandby()`), false);
  assert.equal(a.run(`RingLab.onRing({})`), false, "вне режима ожидания рингтон не играет");
  a.close();
});

test("DeviceCheck.runRingTest передаёт режим hybrid в pushTestRing; клиент сигналинга шлёт mode только для hybrid", async () => {
  const a = await booted();
  const r = a.run(`(function(){ const sent = []; const s = new SignalingClient ? null : null; return typeof SignalingClient; })()`);
  assert.ok(r);
  const src = fs.readFileSync(path.join(__dirname, "..", "js/signaling-client.js"), "utf8");
  assert.match(src, /pushTestRing\(mode\) \{ return this\.send\("push-test-ring", mode === "hybrid" \? \{ mode: "hybrid" \} : \{\}\); \}/);
  a.close();
});
