// Локальный ИИ: согласие, расшифровка с подменённым движком, сохранение, повторный показ, краткое содержание.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closeAll } = require("./harness");
test.after(closeAll);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function booted() {
  const a = createApp({ storage: { "ether.name": "T", "ether.myId": "me-test-id", "ether.lang": "ru" } });
  await a.ready;
  for (let i = 0; i < 60 && !a.run(`typeof __appStarted !== "undefined" && __appStarted`); i++) await sleep(50);
  return a;
}
function setup(a) {
  a.run(`
    const c = ensureContactEntry("alice", "Alice"); c.managed = true;
    c.messages.push({ id: "v1", from: "them", text: "", ts: Date.now(), readAckSent: true, file: { name: "voice-message", mime: "audio/webm", size: 10, kind: "audio", duration: 4 } });
    unreadDividerFor.delete("alice"); state.chatId = "alice"; state.tab = "chats"; renderTab();
    fileBlobUrlCache.set("v1", "blob:v");
    window.AudioContext = class { decodeAudioData() { return Promise.resolve({ duration: 2 }); } close() {} };
    window.OfflineAudioContext = class { constructor(ch, len) { this.len = len; } createBufferSource() { return { connect() {}, start() {} }; } get destination() { return {}; } startRendering() { return Promise.resolve({ getChannelData: () => new Float32Array(this.len) }); } };
    IDB.get = async () => ({ arrayBuffer: async () => new ArrayBuffer(8) });`);
}

test("краткое содержание: выбирает ключевые предложения в исходном порядке, короткий текст не трогает", async () => {
  const a = await booted();
  const S = (t, n) => a.run(`LocalAI.summarize(${JSON.stringify(t)}, ${n || 3})`);
  assert.equal(S("Привет. Как дела?"), "Привет. Как дела?");
  const long = "Завтра релиз приложения. Релиз нужно проверить на iPhone и на Android. Погода сегодня хорошая. Кофе закончился. Проверка релиза на iPhone начнётся утром, а на Android днём. Всем хорошего вечера.";
  const out = S(long, 2);
  assert.ok(/релиз/i.test(out), "выжимка про главное: " + out);
  assert.ok(!/Кофе/.test(out), "несущественное отброшено");
  assert.ok(out.length < long.length);
  a.close();
});

test("расшифровка: отказ от согласия ничего не включает; согласие включает и сохраняет текст", async () => {
  const a = await booted(); setup(a);
  a.run(`LocalAI.setEngine(async () => "привет мир")`);
  a.run(`confirmSheet = () => Promise.resolve(false)`);
  await a.run(`transcribeVoiceMessage("alice", "v1")`);
  assert.equal(a.run(`localAiEnabled()`), false);
  assert.equal(a.run(`!!state.contacts.get("alice").messages[0].file.transcript`), false);
  a.run(`confirmSheet = () => Promise.resolve(true)`);
  await a.run(`transcribeVoiceMessage("alice", "v1")`);
  assert.equal(a.run(`localAiEnabled()`), true);
  assert.equal(a.run(`state.contacts.get("alice").messages[0].file.transcript`), "привет мир");
  await sleep(30);
  assert.equal(a.document.querySelector(".voice-transcript").textContent, "привет мир", "текст виден под голосовым");
  a.close();
});

test("расшифровка: ошибка движка не ломает чат и даёт тост; повторное нажатие скрывает/показывает текст", async () => {
  const a = await booted(); setup(a);
  a.window.localStorage.setItem("ether.localAi", "1");
  a.run(`LocalAI.setEngine(async () => { throw new Error("boom"); })`);
  await a.run(`transcribeVoiceMessage("alice", "v1")`);
  assert.equal(a.run(`!!state.contacts.get("alice").messages[0].file.transcript`), false);
  assert.equal(a.document.querySelector(".voice-transcript"), null, "статус убран после ошибки");
  a.run(`LocalAI.setEngine(async () => "ок")`);
  await a.run(`transcribeVoiceMessage("alice", "v1")`);
  await sleep(30);
  a.document.querySelector(".voice-tr-btn").click();
  await sleep(10);
  assert.ok(a.document.querySelector(".voice-transcript").classList.contains("hidden"), "второй тап скрывает");
  a.close();
});

test("пункт «Краткое содержание» появляется только у длинных сообщений и открывает лист", async () => {
  const a = await booted(); setup(a);
  const longText = ("Нужно купить хлеб и молоко для завтрака. " .repeat(8)) + "Это самое главное сообщение дня.";
  a.run(`state.contacts.get("alice").messages.push({ id: "t1", from: "them", text: ${JSON.stringify(longText)}, ts: Date.now(), readAckSent: true }); renderChatThread();`);
  a.run(`openMessageSheet("t1", "alice")`);
  assert.ok(Array.from(a.document.querySelectorAll("#message-sheet-body [data-action]")).some((b) => b.getAttribute("data-action") === "summary"));
  a.run(`openSummarySheet(${JSON.stringify(longText)})`);
  assert.ok(!a.document.querySelector("#ai-sheet").classList.contains("hidden"));
  assert.ok(a.document.querySelector("#ai-sheet-text").textContent.length > 10);
  a.run(`state.contacts.get("alice").messages.push({ id: "t2", from: "them", text: "коротко", ts: Date.now() }); openMessageSheet("t2", "alice")`);
  assert.ok(!Array.from(a.document.querySelectorAll("#message-sheet-body [data-action]")).some((b) => b.getAttribute("data-action") === "summary"));
  a.close();
});
