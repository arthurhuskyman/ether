const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closeAll } = require("./harness");
test.after(closeAll);

const flush = () => new Promise((r) => setTimeout(r, 200));
async function waitFor(fn, ms = 4000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; }

function withGroup(a) {
  a.run(`Store.myId = "me"; Store.name = "Me";
    ensureContactEntry("alice", "Alice"); ensureContactEntry("bob", "Bob");
    state.contacts.set("g1", {id:"g1", name:"Team", managed:true, isGroup:true, createdBy:"alice",
      members:[{id:"alice", name:"Alice", role:"admin"}, {id:"me", name:"Me"}], messages:[], lastActivity:1});`);
}

test("chat: 1:1 сообщение, дедупликация по id", () => {
  const a = createApp();
  a.run(`applyIncomingPayload("alice", "d1", {kind:"chat", id:"m1", text:"hello", ts:5})`);
  a.run(`applyIncomingPayload("alice", "d2", {kind:"chat", id:"m1", text:"hello", ts:5})`);
  assert.equal(a.run(`state.contacts.get("alice").messages.length`), 1);
  assert.equal(a.run(`state.contacts.get("alice").messages[0].text`), "hello");
  a.close();
});

test("chat: сообщение в неизвестную группу игнорируется, в известную — попадает в группу", () => {
  const a = createApp();
  withGroup(a);
  a.run(`applyIncomingPayload("alice", "d1", {kind:"chat", id:"x", text:"?", groupId:"nogroup"})`);
  a.run(`applyIncomingPayload("alice", "d2", {kind:"chat", id:"g-m1", text:"hi team", groupId:"g1", senderName:"Alice"})`);
  assert.equal(a.run(`state.contacts.get("g1").messages.length`), 1);
  assert.equal(a.run(`state.contacts.get("g1").messages[0].fromId`), "alice");
  assert.equal(a.run(`state.contacts.get("alice").messages.length`), 0);
  a.close();
});

test("chat: writeRestricted — не-админ не может писать в группу", () => {
  const a = createApp();
  withGroup(a);
  a.run(`state.contacts.get("g1").writeRestricted = true; state.contacts.get("g1").members.push({id:"bob", name:"Bob"});`);
  a.run(`applyIncomingPayload("bob", "d1", {kind:"chat", id:"r1", text:"nope", groupId:"g1"})`);
  a.run(`applyIncomingPayload("alice", "d2", {kind:"chat", id:"r2", text:"ok", groupId:"g1"})`);
  assert.deepEqual(JSON.parse(a.run(`JSON.stringify(state.contacts.get("g1").messages.map(m => m.id))`)), ["r2"]);
  a.close();
});

test("edit/delete 1:1 применяются к чату с отправителем", () => {
  const a = createApp();
  a.run(`applyIncomingPayload("alice", "d1", {kind:"chat", id:"m1", text:"v1"})`);
  a.run(`applyIncomingPayload("alice", "d2", {kind:"edit", id:"m1", text:"v2", ts:9})`);
  assert.equal(a.run(`state.contacts.get("alice").messages[0].text`), "v2");
  assert.equal(a.run(`state.contacts.get("alice").messages[0].edited`), true);
  a.run(`applyIncomingPayload("alice", "d3", {kind:"delete", id:"m1"})`);
  assert.equal(a.run(`state.contacts.get("alice").messages.length`), 0);
  a.close();
});

test("edit/delete с groupId применяются к группе и только автором-участником", () => {
  const a = createApp();
  withGroup(a);
  a.run(`state.contacts.get("g1").members.push({id:"bob", name:"Bob"});`);
  a.run(`applyIncomingPayload("alice", "d1", {kind:"chat", id:"gm", text:"orig", groupId:"g1"})`);
  // чужое сообщение (bob не автор) — правка и удаление игнорируются
  a.run(`applyIncomingPayload("bob", "d2", {kind:"edit", id:"gm", text:"hacked", groupId:"g1"})`);
  a.run(`applyIncomingPayload("bob", "d3", {kind:"delete", id:"gm", groupId:"g1"})`);
  assert.equal(a.run(`state.contacts.get("g1").messages[0].text`), "orig");
  // автор — применяется
  a.run(`applyIncomingPayload("alice", "d4", {kind:"edit", id:"gm", text:"fixed", groupId:"g1"})`);
  assert.equal(a.run(`state.contacts.get("g1").messages[0].text`), "fixed");
  // не участник группы — игнорируется, а 1:1 чат с ним не создаётся
  a.run(`applyIncomingPayload("mallory", "d5", {kind:"delete", id:"gm", groupId:"g1"})`);
  assert.equal(a.run(`state.contacts.get("g1").messages.length`), 1);
  assert.equal(a.run(`state.contacts.has("mallory")`), false);
  // неизвестная группа
  a.run(`applyIncomingPayload("alice", "d6", {kind:"edit", id:"gm", text:"z", groupId:"nogroup"})`);
  a.run(`applyIncomingPayload("alice", "d7", {kind:"delete", id:"gm", groupId:"g1"})`);
  assert.equal(a.run(`state.contacts.get("g1").messages.length`), 0);
  a.close();
});

const META = `{kind:"file-meta", id:"f1", name:"a.txt", mime:"text/plain", size:6, totalChunks:2}`;

test("file-meta: валидация totalChunks и size", () => {
  const a = createApp();
  for (const bad of [0, -1, 501, 1.5, "x"]) {
    a.run(`handleFilePayload("alice", {kind:"file-meta", id:"b", name:"a", mime:"x/y", size:6, totalChunks:${JSON.stringify(bad)}})`);
  }
  a.run(`handleFilePayload("alice", {kind:"file-meta", id:"b", name:"a", mime:"x/y", size:-5, totalChunks:2})`);
  assert.equal(a.run(`incomingFileBuffers.size`), 0);
  a.close();
});

test("file-meta: повторный не затирает принятые чанки и не дублирует сообщение", () => {
  const a = createApp();
  a.run(`handleFilePayload("alice", ${META})`);
  a.run(`handleFilePayload("alice", {kind:"file-chunk", id:"f1", index:0, data:"YWJj"})`);
  a.run(`handleFilePayload("alice", ${META})`);
  assert.equal(a.run(`incomingFileBuffers.get("f1").chunks[0]`), "YWJj");
  assert.equal(a.run(`state.contacts.get("alice").messages.length`), 1);
  a.close();
});

test("file-meta: повтор после вычистки буфера по TTL заводит буфер заново без дубля сообщения", () => {
  const a = createApp();
  a.run(`handleFilePayload("alice", ${META})`);
  a.run(`incomingFileBuffers.get("f1").receivedAt = 0; sweepIncomingFileBuffers();`);
  assert.equal(a.run(`incomingFileBuffers.size`), 0);
  a.run(`handleFilePayload("alice", ${META})`);
  assert.equal(a.run(`incomingFileBuffers.size`), 1);
  assert.equal(a.run(`state.contacts.get("alice").messages.length`), 1);
  a.close();
});

test("file-meta: лимит одновременных приёмов", () => {
  const a = createApp();
  for (let i = 0; i < 25; i++) a.run(`handleFilePayload("alice", {kind:"file-meta", id:"id${i}", name:"a", mime:"x/y", size:6, totalChunks:1})`);
  assert.equal(a.run(`incomingFileBuffers.size`), a.run(`MAX_INCOMING_FILE_TRANSFERS`));
  a.close();
});

test("file-chunk: индекс вне диапазона и неизвестный id игнорируются; file-done собирает файл", async () => {
  const a = createApp();
  await a.ready;
  a.run(`handleFilePayload("alice", ${META})`);
  a.run(`handleFilePayload("alice", {kind:"file-chunk", id:"zzz", index:0, data:"YQ=="})`);
  a.run(`handleFilePayload("alice", {kind:"file-chunk", id:"f1", index:5, data:"YQ=="})`);
  a.run(`handleFilePayload("alice", {kind:"file-chunk", id:"f1", index:-1, data:"YQ=="})`);
  a.run(`handleFilePayload("alice", {kind:"file-chunk", id:"f1", index:0, data:"YWJj"})`);
  a.run(`handleFilePayload("alice", {kind:"file-chunk", id:"f1", index:1, data:"ZGVm"})`);
  a.run(`handleFilePayload("alice", {kind:"file-done", id:"f1"})`);
  await waitFor(() => a.run(`state.contacts.get("alice").messages[0].file.pending`) === false);
  assert.equal(a.run(`incomingFileBuffers.size`), 0);
  assert.equal(a.run(`state.contacts.get("alice").messages[0].file.pending`), false);
  assert.notEqual(a.run(`state.contacts.get("alice").messages[0].file.failed`), true);
  a.close();
});

test("file-done с недостающим куском помечает файл как failed", async () => {
  const a = createApp();
  await a.ready;
  a.run(`handleFilePayload("alice", ${META})`);
  a.run(`handleFilePayload("alice", {kind:"file-chunk", id:"f1", index:0, data:"YWJj"})`);
  a.run(`handleFilePayload("alice", {kind:"file-done", id:"f1"})`);
  await flush();
  assert.equal(a.run(`state.contacts.get("alice").messages[0].file.failed`), true);
  a.run(`handleFilePayload("alice", {kind:"file-done", id:"unknown"})`);
  a.close();
});

test("file-chunk сверх заявленного размера обрывает приём", () => {
  const a = createApp();
  a.run(`handleFilePayload("alice", ${META})`);
  a.run(`handleFilePayload("alice", {kind:"file-chunk", id:"f1", index:0, data:"A".repeat(100000)})`);
  assert.equal(a.run(`incomingFileBuffers.has("f1")`), false);
  a.close();
});

test("translateMessage: успех, ошибка, повторный тап скрывает, таймаут передаётся", async () => {
  let seen;
  const a = createApp({ fetch: async (url, init) => { seen = init; return { ok: true, json: async () => ({ translatedText: "Привет" }) }; } });
  await a.ready;
  a.run(`ensureContactEntry("alice", "Alice"); state.contacts.get("alice").messages.push({id:"t1", from:"them", text:"hello"}); Store.translateEndpoint = "http://tr.local/translate";`);
  await a.run(`translateMessage("alice", "t1")`);
  assert.equal(a.run(`state.contacts.get("alice").messages[0].translation.text`), "Привет");
  assert.ok(seen.signal, "fetch должен получать AbortSignal (таймаут)");
  await a.run(`translateMessage("alice", "t1")`); // повторный тап — скрыть
  assert.equal(a.run(`state.contacts.get("alice").messages[0].translation`), undefined);
  a.close();

  const b = createApp({ fetch: async () => { throw new Error("abort"); } });

  await b.ready;
  b.run(`ensureContactEntry("alice", "Alice"); state.contacts.get("alice").messages.push({id:"t1", from:"them", text:"hello"}); Store.translateEndpoint = "http://tr.local/translate";`);
  await b.run(`translateMessage("alice", "t1")`);
  assert.equal(b.run(`_translateInFlight.has("t1")`), false, "msgId должен сниматься с in-flight после ошибки");
  assert.ok(b.document.querySelector("#toast").textContent.length > 0);
  b.close();

  const c = createApp();

  await c.ready;
  c.run(`ensureContactEntry("alice", "Alice"); state.contacts.get("alice").messages.push({id:"t1", from:"them", text:"hello"}); Store.translateEndpoint = "";`);
  await c.run(`translateMessage("alice", "t1")`);
  assert.ok(c.document.querySelector("#toast").textContent.length > 0);
  c.close();
});

test("importBackupFile: файл без ключей ether.* отклоняется и ничего не стирает", async () => {
  const a = createApp();
  await a.ready;
  a.window.localStorage.setItem("ether.keep", "1");
  a.run(`confirmSheet = async () => true;`);
  const file = { text: async () => JSON.stringify({ hello: "world" }) };
  a.window.__f = file;
  await a.run(`importBackupFile(window.__f)`);
  assert.equal(a.window.localStorage.getItem("ether.keep"), "1");
  a.close();
});

test("importBackupFile: валидный бэкап заменяет данные, нестроковые значения пропускаются", async () => {
  const a = createApp();
  await a.ready;
  a.window.localStorage.setItem("ether.old", "1");
  a.run(`confirmSheet = async () => true; location.reload = () => {};`);
  a.window.__f = { text: async () => JSON.stringify({ "ether.name": "Zed", "ether.bad": { x: 1 } }) };
  await a.run(`importBackupFile(window.__f)`);
  assert.equal(a.window.localStorage.getItem("ether.name"), "Zed");
  assert.equal(a.window.localStorage.getItem("ether.old"), null);
  assert.equal(a.window.localStorage.getItem("ether.bad"), null);
  a.close();
});

test("importBackupFile: отмена подтверждения ничего не меняет, битый JSON даёт тост", async () => {
  const a = createApp();
  await a.ready;
  a.window.localStorage.setItem("ether.keep", "1");
  a.run(`confirmSheet = async () => false;`);
  a.window.__f = { text: async () => JSON.stringify({ "ether.name": "Zed" }) };
  await a.run(`importBackupFile(window.__f)`);
  assert.equal(a.window.localStorage.getItem("ether.keep"), "1");
  a.window.__f = { text: async () => "{nope" };
  await a.run(`importBackupFile(window.__f)`);
  assert.ok(a.document.querySelector("#toast").textContent.length > 0);
  a.close();
});

test("updateCallQualityIcon не показывает иконку, если звонок уже завершён", async () => {
  const a = createApp();
  await a.ready;
  a.run(`state.callId = null;`);
  const icon = a.document.querySelector("#call-quality-icon");
  icon.classList.add("hidden");
  a.window.__pc = { getStats: async () => new Map([["p", { type: "candidate-pair", state: "succeeded", currentRoundTripTime: 0.01 }]]) };
  await a.run(`updateCallQualityIcon(window.__pc)`);
  assert.ok(icon.classList.contains("hidden"));
  a.run(`state.callId = "alice";`);
  await a.run(`updateCallQualityIcon(window.__pc)`);
  assert.ok(!icon.classList.contains("hidden"));
  a.close();
});

test("cancelVoiceRecordingIfLeavingChat отменяет запись, ещё ждущую getUserMedia", async () => {
  const a = createApp();
  await a.ready;
  let stopped = 0;
  const track = { stop() { stopped++; } };
  let release;
  a.window.navigator.mediaDevices = { getUserMedia: () => new Promise((r) => { release = () => r({ getTracks: () => [track] }); }) };
  a.window.MediaRecorder = class { constructor() { throw new Error("must not be created"); } static isTypeSupported() { return true; } };
  a.run(`state.chatId = "alice";`);
  const p = a.run(`startVoiceRecording()`);
  a.run(`cancelVoiceRecordingIfLeavingChat("bob")`);
  release();
  await p;
  assert.equal(stopped, 1, "микрофонный поток должен быть остановлен");
  assert.ok(a.document.querySelector("#voice-recording-bar").classList.contains("hidden"));
  a.close();
});

test("resolveEditDeleteTarget: без groupId → 1:1 контакт", () => {
  const a = createApp();
  assert.equal(a.run(`resolveEditDeleteTarget("zed", {}).id`), "zed");
  assert.equal(a.run(`resolveEditDeleteTarget("zed", {groupId:"nope"})`), null);
  a.close();
});

test("global search: debounce — рендер откладывается", async () => {
  const a = createApp();
  await a.ready;
  a.run(`wireGlobalSearch();`);
  a.run(`ensureContactEntry("alice", "Alice"); state.contacts.get("alice").messages.push({id:"1", from:"them", text:"needle here", ts:1});`);
  const input = a.document.querySelector("#global-search-input");
  input.value = "needle";
  input.dispatchEvent(new a.window.Event("input"));
  assert.equal(a.document.querySelector("#global-search-results").innerHTML, "");
  await new Promise((r) => setTimeout(r, 250));
  assert.match(a.document.querySelector("#global-search-results").innerHTML, /needle|Alice/i);
  a.close();
});

test("renderChatsList: тумблер архива учитывает фильтр", () => {
  const a = createApp();
  a.run(`ensureContactEntry("alice", "Alice"); const g = {id:"g1", name:"G", managed:true, isGroup:true, members:[], messages:[], lastActivity:1, archived:true}; state.contacts.set("g1", g);
    state._firstRenderDone = true; state.chatFilter = "direct"; renderChatsList();`);
  const toggle = a.document.querySelector("#chats-archived-toggle");
  assert.ok(toggle.classList.contains("hidden"), "архивная группа не подходит под фильтр Direct");
  a.run(`state.chatFilter = "groups"; renderChatsList();`);
  assert.ok(!toggle.classList.contains("hidden"));
  a.close();
});

test("wireConfirmSheet: клик по подложке и Esc отменяют подтверждение", async () => {
  const a = createApp();
  await a.ready;
  a.run(`wireConfirmSheet();`);
  let p = a.run(`confirmSheet("sure?")`);
  a.document.querySelector("#confirm-sheet .sheet-backdrop").dispatchEvent(new a.window.MouseEvent("click", { bubbles: true }));
  assert.equal(await p, false);
  p = a.run(`confirmSheet("sure?")`);
  a.document.dispatchEvent(new a.window.KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal(await p, false);
  p = a.run(`confirmSheet("sure?")`);
  a.document.querySelector("#confirm-sheet-ok").click();
  assert.equal(await p, true);
  a.close();
});

test("deleteContact чистит groupDeliveryMap получателя", () => {
  const a = createApp();
  a.run(`ensureContactEntry("alice", "Alice"); groupDeliveryMap.set("d1", {groupId:"g", contentId:"c", to:"alice"}); groupDeliveryMap.set("d2", {groupId:"g", contentId:"c", to:"bob"}); mesh = { remove() {}, get() { return null; } }; deleteContact("alice");`);
  assert.equal(a.run(`groupDeliveryMap.has("d1")`), false);
  assert.equal(a.run(`groupDeliveryMap.has("d2")`), true);
  a.close();
});

test("retryMessage: некорректный file.size заменяется на blob.size", async () => {
  const a = createApp();
  await a.ready;
  a.run(`ensureContactEntry("alice", "Alice"); window.__sent = null;
    state.contacts.get("alice").messages.push({id:"fm", from:"me", text:"", file:{name:"a.bin", mime:"x/y", size:"oops"}});
    trySendOrQueue = async (c, id, payload) => { window.__sent = payload; };`);
  await a.run(`IDB.set("file:fm", new Blob(["abcd"]))`);
  await a.run(`retryMessage("alice", "fm")`);
  assert.equal(a.window.__sent.size, 4);
  a.close();
});
