// V.78 этап 4: бейдж непрочитанных в треде, периоды сводки (50/200/непрочитанные) и даты, aria-аудит, aria-pressed, потолок фото-истории.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closeAll } = require("./harness");
test.after(closeAll);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function booted(lang) {
  const a = createApp({ storage: { "ether.name": "T", "ether.myId": "me-test-id", "ether.lang": lang || "en" } });
  await a.ready;
  for (let i = 0; i < 60 && !a.run(`typeof __appStarted !== "undefined" && __appStarted`); i++) await sleep(50);
  return a;
}

test("тред: бейдж непрочитанных ответов на чипе, гаснет после открытия панели; фокус в поле ответа", async () => {
  const a = await booted(); const d = a.document;
  a.run(`const c = ensureContactEntry("alice", "Alice"); c.managed = true; const t = Date.now();
    c.messages.push({ id: "r1", from: "me", text: "root", ts: t - 5000 });
    c.messages.push({ id: "r2", from: "them", text: "a1", ts: t - 4000, replyTo: { id: "r1", text: "root" } });
    c.messages.push({ id: "r3", from: "them", text: "a2", ts: t - 3000, replyTo: { id: "r1", text: "root" } });
    state.chatId = "alice"; state.tab = "chats"; renderTab();`);
  let chip = d.querySelector('[data-thread="r1"]');
  assert.equal(chip.querySelector(".thread-unread").textContent, "2");
  assert.match(chip.getAttribute("aria-label"), /unread: 2/);
  chip.click();
  await sleep(150);
  chip = d.querySelector('[data-thread="r1"]');
  assert.equal(chip.querySelector(".thread-unread"), null, "после открытия бейдж погас");
  assert.equal(d.activeElement.id, "thread-input");
  a.close();
});

test("сводка: последние N, непрочитанные, даты и время; без navigator.share кнопка «Поделиться» скрыта", async () => {
  const a = await booted(); const d = a.document;
  a.run(`{ const c = ensureContactEntry("alice", "Alice"); c.managed = true; const n = Date.now();
    for (let i = 0; i < 60; i++) c.messages.push({ id: "m" + i, from: i % 2 ? "me" : "them", text: i === 58 ? "Встреча 25.12 в 18:30 у входа." : "сообщение номер " + i, ts: n - (70 - i) * 1000, readAckSent: i < 55 });
  }`);
  const dig = (o) => JSON.parse(a.run(`JSON.stringify(LocalAI.chatDigest(state.contacts.get("alice"), ${JSON.stringify(o)}))`));
  assert.equal(dig({ last: 50 }).count, 50);
  assert.equal(dig({}).count, 60);
  const un = dig({ unread: true }); assert.ok(un.count > 0 && un.count < 60);
  assert.ok(dig({}).dates.some((x) => /25\.12/.test(x)));
  a.run(`openChatSummary("alice")`);
  d.querySelector('.summary-period[data-period="last50"]').click();
  assert.equal(d.querySelector('.summary-period[data-period="last50"]').getAttribute("aria-pressed"), "true");
  assert.match(d.querySelector("#summary-body").textContent, /50/);
  assert.match(d.querySelector("#summary-body").textContent, /Dates and times/);
  assert.ok(d.querySelector("#summary-share").classList.contains("hidden"));
  a.close();
});

test("aria: у иконочных кнопок и полей есть имя, тост — role=status, переключатели получают aria-pressed", async () => {
  const a = await booted(); const d = a.document;
  for (const id of ["chat-back", "contact-back", "chat-search-close", "reply-cancel-btn", "edit-cancel-btn", "multiselect-cancel-btn", "glass-slider", "call-volume-slider", "new-group-avatar-btn", "group-info-avatar-btn", "rename-input", "jump-date-input"]) {
    const el = d.getElementById(id); assert.ok(el && el.getAttribute("aria-label"), id + " без aria-label");
    assert.ok(el.hasAttribute("data-i18n-aria"), id + " без data-i18n-aria");
  }
  assert.equal(d.getElementById("toast").getAttribute("role"), "status");
  assert.equal(d.getElementById("toast").getAttribute("aria-live"), "polite");
  assert.equal(d.getElementById("call-notice").getAttribute("role"), "status");
  const sw = d.querySelectorAll("#story-swatches .story-swatch, .theme-seg button");
  await sleep(150);
  assert.ok(sw.length > 0 && Array.from(sw).every((b) => b.hasAttribute("aria-pressed")));
  const m = d.getElementById("call-mute-btn"); m.classList.add("active"); await sleep(120);
  assert.equal(m.getAttribute("aria-pressed"), "true");
  a.close();
});

test("фото-история: потолок на отправке 300 КБ, на приёме 400 КБ", async () => {
  const a = await booted();
  assert.equal(a.run(`STORY_PHOTO_TARGET_BYTES`), 300 * 1024);
  assert.equal(a.run(`STORY_PHOTO_MAX_BYTES`), 400 * 1024);
  a.close();
});
