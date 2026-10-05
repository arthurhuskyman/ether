const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closeAll } = require("./harness");
test.after(closeAll);

const PROFILE = { "ether.name": "Tester", "ether.myId": "me-test-id", "ether.lang": "en" };
async function booted(extra = {}) {
  const a = createApp({ storage: { ...PROFILE, ...extra } });
  await a.ready;
  for (let i = 0; i < 40 && !a.run(`typeof __appStarted !== "undefined" && __appStarted`); i++) await new Promise((r) => setTimeout(r, 50));
  return a;
}

test("запуск с профилем: приложение стартует, показывается список чатов", async () => {
  const a = await booted();
  assert.equal(a.run(`__appStarted`), true);
  assert.ok(!a.document.querySelector("#app-shell").classList.contains("hidden"));
  assert.equal(a.run(`typeof mesh`), "object");
  a.close();
});

function seed(a) {
  a.run(`Store.myId = Store.myId || "me-test-id";
    const al = ensureContactEntry("alice", "Alice"); al.publicKey = null;
    al.messages.push({id:"a1", from:"them", text:"hello https://example.com there", ts: Date.now()-5000, readAckSent:false},
                     {id:"a2", from:"me", text:"hi **bold**", ts: Date.now()-4000, ack:"read"},
                     {id:"a3", from:"me", text:"", ts: Date.now()-3000, file:{name:"p.png", mime:"image/png", size:10, kind:"image"}},
                     {id:"a4", from:"them", text:"fav", ts: Date.now()-2000, favorite:true, reactions:{"👍":["alice"]}});
    ensureContactEntry("bob", "Bob").archived = true;
    state.contacts.set("g1", {id:"g1", name:"Team", managed:true, isGroup:true, createdBy:"me-test-id",
      members:[{id:"me-test-id", name:"Tester", role:"admin"}, {id:"alice", name:"Alice"}], messages:[{id:"g-1", from:"them", fromId:"alice", fromName:"Alice", text:"yo", ts:Date.now()-1000}], lastActivity: Date.now()});
    state._firstRenderDone = true; persistContacts(); renderChatsList();`);
}

test("смоук: переключение вкладок, открытие чата и всех шторок без исключений", async () => {
  const a = await booted();
  seed(a);
  const errs = [];
  a.window.addEventListener("error", (e) => errs.push(e.message));
  for (const btn of a.document.querySelectorAll(".tab-btn")) { btn.click(); await new Promise((r) => setTimeout(r, 20)); }
  a.run(`state.chatId = "alice"; renderTab();`);
  await new Promise((r) => setTimeout(r, 50));
  a.run(`state.chatId = "g1"; renderTab();`);
  await new Promise((r) => setTimeout(r, 50));
  a.run(`state.chatId = null; renderTab();`);
  // каждая шторка: показать и закрыть
  for (const sheet of a.document.querySelectorAll(".sheet")) {
    sheet.classList.remove("hidden"); await new Promise((r) => setTimeout(r, 5));
    sheet.classList.add("hidden");
  }
  assert.deepEqual(errs, []);
  a.close();
});

test("смоук: клик по каждой кнопке с id не бросает исключений", async () => {
  const a = await booted();
  seed(a);
  a.run(`confirmSheet = async () => false; location.reload = () => {};`);
  const errs = [];
  a.window.addEventListener("error", (e) => errs.push(e.message));
  const skip = /reset|delete|wipe|clear|panic|logout|import|export/i;
  const ids = Array.from(a.document.querySelectorAll("button[id]")).map((b) => b.id).filter((id) => !skip.test(id));
  for (const id of ids) {
    const el = a.document.getElementById(id);
    if (!el || el.disabled) continue;
    try { el.click(); } catch (e) { errs.push(id + ": " + e.message); }
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.deepEqual(errs, []);
  a.close();
});

test("смоук: ввод в поля, переключатели, select, строки списков, отправка сообщения", async () => {
  const a = await booted();
  seed(a);
  a.run(`confirmSheet = async () => false; location.reload = () => {};`);
  const errs = [];
  a.window.addEventListener("error", (e) => errs.push(e.message));
  const ev = (n) => new a.window.Event(n, { bubbles: true });
  const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
  for (const tab of ["chats", "calls", "contacts", "settings"]) {
    const b = a.document.querySelector(`.tab-btn[data-tab="${tab}"]`); if (b) b.click(); await tick(20);
    for (const row of a.document.querySelectorAll(".chat-row, .contact-row, .settings-category-row, .settings-category-btn, .call-row")) {
      try { row.click(); } catch (e) { errs.push(String(e)); } await tick(2);
    }
  }
  for (const inp of a.document.querySelectorAll("input[type=text], input[type=search], input:not([type]), textarea")) {
    inp.value = "al"; inp.dispatchEvent(ev("input")); inp.dispatchEvent(ev("change")); await tick(2);
    inp.value = "";  inp.dispatchEvent(ev("input"));
  }
  for (const cb of a.document.querySelectorAll("input[type=checkbox]")) { cb.checked = !cb.checked; cb.dispatchEvent(ev("change")); await tick(2); }
  for (const sel of a.document.querySelectorAll("select")) {
    for (const o of Array.from(sel.options).slice(0, 3)) { sel.value = o.value; sel.dispatchEvent(ev("change")); await tick(2); }
  }
  // отправка сообщения в открытом чате
  a.run(`state.chatId = "alice"; renderTab();`);
  await tick(30);
  const input = a.document.querySelector("#chat-input");
  if (input) {
    input.value = "test message"; input.dispatchEvent(ev("input"));
    const form = a.document.querySelector("#chat-form");
    if (form) form.dispatchEvent(new a.window.Event("submit", { bubbles: true, cancelable: true }));
    await tick(50);
    assert.ok(a.run(`state.contacts.get("alice").messages.some((m) => m.text === "test message")`));
  }
  assert.deepEqual(errs, []);
  a.close();
});
