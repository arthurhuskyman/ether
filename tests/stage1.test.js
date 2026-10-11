// Этап 1: B6 (блок звонков), B8 (кэш tune), B9 (таймер), B10 (окно дедупликации по времени), B13, B14, B15, A5 (права группы), A7 (пул ICE), A8 (превью по запросу)
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closeAll } = require("./harness");
test.after(closeAll);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function booted(extra) {
  const a = createApp({ storage: Object.assign({ "ether.name": "T", "ether.myId": "me-test-id", "ether.lang": "ru" }, extra || {}) });
  await a.ready;
  for (let i = 0; i < 60 && !a.run(`typeof __appStarted !== "undefined" && __appStarted`); i++) await sleep(50);
  return a;
}

test("B6: звонок от заблокированного — тишина у нас, обычный «отклонён» звонящему через 20–30 с, без повторных таймеров; разблокировка отменяет", async () => {
  const a = await booted();
  a.run(`const c = ensureContactEntry("alice", "Alice"); c.managed = true; c.blocked = true;
    window.__q = []; window.__sig = []; const realST = setTimeout; setTimeout = (fn, ms) => { window.__q.push([fn, ms]); return 1; };
    window.__fakeSig = { signal: (to, p) => { window.__sig.push([to, p]); return true; } };`);
  a.run(`scheduleBlockedCallDecline("alice", window.__fakeSig)`);
  a.run(`scheduleBlockedCallDecline("alice", window.__fakeSig)`); // повторное приглашение
  const q = a.run(`window.__q.map((x) => x[1])`);
  assert.equal(q.length, 1, "один таймер на серию приглашений");
  assert.ok(q[0] >= 20000 && q[0] < 30000, "задержка " + q[0]);
  assert.equal(a.run(`window.__sig.length`), 0, "сразу ничего не отправлено");
  a.run(`window.__q[0][0]()`);
  assert.deepEqual(JSON.parse(JSON.stringify(a.run(`window.__sig`))), [["alice", { t: "call-declined" }]]);
  // разблокировали до срабатывания — не отвечаем
  a.run(`blockedCallDecline.clear(); window.__sig.length = 0; window.__q.length = 0; scheduleBlockedCallDecline("alice", window.__fakeSig); state.contacts.get("alice").blocked = false; window.__q[0][0]();`);
  assert.equal(a.run(`window.__sig.length`), 0);
  a.close();
});

test("B6: список заблокированных уходит в service worker", async () => {
  const a = await booted();
  a.run(`window.__posted = []; Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { controller: { postMessage: (m) => window.__posted.push(m) } } });
    const c = ensureContactEntry("bob", "Bob"); c.managed = true; c.blocked = true; persistContacts();`);
  assert.deepEqual(JSON.parse(JSON.stringify(a.run(`window.__posted.filter((m) => m.type === "blocked-ids").pop()`))), { type: "blocked-ids", ids: ["bob"] });
  a.close();
});

test("A5: group-invite от не-админа не меняет группу, самовыход принимается, админ меняет всё", async () => {
  const a = await booted();
  a.run(`const g = ensureContactEntry("grp", "Команда"); g.managed = true; g.isGroup = true; g.createdBy = "alice";
    g.members = [{ id: "me-test-id", name: "Я" }, { id: "alice", name: "Alice", role: "admin" }, { id: "bob", name: "Bob" }];`);
  const inv = (from, members, name, id) => a.run(`applyIncomingPayload(${JSON.stringify(from)}, "e${id}", { kind: "group-invite", id: "i${id}", groupId: "grp", groupName: ${JSON.stringify(name)}, members: ${JSON.stringify(members)} }, true)`);
  // Боб (не админ) пытается переименовать и выдать себе роль
  inv("bob", [{ id: "me-test-id", name: "Я" }, { id: "alice", name: "Alice", role: "admin" }, { id: "bob", name: "Bob", role: "admin" }], "Взломано", 1);
  assert.equal(a.run(`state.contacts.get("grp").name`), "Команда");
  assert.equal(a.run(`isGroupAdmin(state.contacts.get("grp"), "bob")`), false);
  // Боб пытается выкинуть Алису
  inv("bob", [{ id: "me-test-id", name: "Я" }, { id: "bob", name: "Bob" }], "Команда", 2);
  assert.equal(a.run(`state.contacts.get("grp").members.length`), 3);
  // Боб выходит сам — из списка убирается только он, роли не берутся из пакета
  inv("bob", [{ id: "me-test-id", name: "Я" }, { id: "alice", name: "Alice", role: "member" }], "Команда", 3);
  assert.deepEqual(JSON.parse(JSON.stringify(a.run(`state.contacts.get("grp").members.map((m) => m.id)`))), ["me-test-id", "alice"]);
  assert.equal(a.run(`isGroupAdmin(state.contacts.get("grp"), "alice")`), true, "роль админа осталась");
  // админ переименовывает
  inv("alice", [{ id: "me-test-id", name: "Я" }, { id: "alice", name: "Alice", role: "admin" }], "Новое имя", 4);
  assert.equal(a.run(`state.contacts.get("grp").name`), "Новое имя");
  a.close();
});

test("B10: окно дедупликации — по времени, старые id забываются, свежие помнятся при плотном потоке", async () => {
  const a = await booted();
  a.run(`for (let i = 0; i < 700; i++) rememberDeliverId("x|" + i);`);
  assert.equal(a.run(`seenDeliverIds.has("x|0")`), true, "старше лимита по числу, но моложе 24 ч — помним");
  a.run(`seenDeliverIds.set("x|0", Date.now() - 25 * 3600e3); rememberDeliverId("new|1");`);
  assert.equal(a.run(`seenDeliverIds.has("x|0")`), false, "просрочено");
  assert.equal(a.run(`seenDeliverIds.has("x|1")`), true);
  a.close();
});

test("B15: разбивка хранилища по категориям", async () => {
  const a = await booted();
  a.run(`const c = ensureContactEntry("alice", "Alice"); c.managed = true;
    c.messages.push({ id: "p1", from: "them", text: "", ts: Date.now(), file: { kind: "image", size: 3000, name: "a.jpg", mime: "image/jpeg" } },
      { id: "v1", from: "them", text: "", ts: Date.now(), file: { kind: "audio", size: 500, name: "v", mime: "audio/webm" } },
      { id: "d1", from: "them", text: "", ts: Date.now(), file: { kind: "file", size: 1200, name: "d.pdf", mime: "application/pdf" } },
      { id: "x1", from: "them", text: "", ts: Date.now(), file: { kind: "image", size: 9999, name: "p", mime: "image/png", pending: true } });`);
  const bd = await a.run(`computeStorageBreakdown([{ key: "ether.contacts", size: 777 }, { key: "ether.name", size: 5 }])`);
  const m = Object.fromEntries(bd.rows.map((r) => [r.key, r.bytes]));
  assert.equal(m.photos, 3000, "незавершённые не считаются"); assert.equal(m.voice, 500); assert.equal(m.files, 1200);
  assert.equal(m.messages, 777); assert.equal(m.other, 5);
  a.close();
});

test("A8: превью ссылок по умолчанию спрашивает; «Показать превью» запоминается; режимы off/auto и миграция старого переключателя", async () => {
  const a = await booted();
  const d = a.document;
  assert.equal(a.run(`Store.linkPreviewMode`), "ask");
  a.run(`const c = ensureContactEntry("alice", "Alice"); c.managed = true; c.messages.push({ id: "l1", from: "them", text: "смотри https://example.com/page", ts: Date.now(), readAckSent: true });
    unreadDividerFor.delete("alice"); state.chatId = "alice"; state.tab = "chats"; renderTab();`);
  const ask = d.querySelector(".link-preview-ask");
  assert.ok(ask, "кнопка вместо автозагрузки");
  assert.equal(d.querySelector(".link-preview-slot"), null, "сервер ссылку не открывал");
  ask.click();
  assert.ok(a.run(`linkPreviewAllowed.has("https://example.com/page")`));
  assert.equal(d.querySelector(".link-preview-ask"), null);
  a.window.localStorage.setItem("ether.linkPreviewMode", "off"); a.run(`renderChatThread()`);
  assert.equal(d.querySelector(".link-preview-ask"), null);
  a.window.localStorage.removeItem("ether.linkPreviewMode"); a.window.localStorage.setItem("ether.linkPreviews", "1");
  assert.equal(a.run(`Store.linkPreviewMode`), "auto");
  a.window.localStorage.setItem("ether.linkPreviews", "0");
  assert.equal(a.run(`Store.linkPreviewMode`), "off");
  a.close();
});

test("B9/B13/B14: таймер звонка в мини-плашке, ранний отказ по размеру файла в группе, идемпотентные настройки", async () => {
  const a = await booted();
  a.run(`document.querySelector("#mini-call-timer").textContent = "x"; state.callPhase = "active"; paintCallTimer(Date.now() - 65000);`);
  assert.equal(a.document.querySelector("#mini-call-timer").textContent, "01:05");
  a.run(`const g = ensureContactEntry("grp", "G"); g.managed = true; g.isGroup = true; g.createdBy = "me-test-id"; g.members = [{ id: "me-test-id", name: "Я" }];`);
  const before = a.run(`state.contacts.get("grp").messages.length`);
  await a.run(`sendGroupFile("grp", { size: 3 * 1024 * 1024, type: "image/png", name: "big.png", arrayBuffer: () => { window.__read = true; return Promise.resolve(new ArrayBuffer(1)); } })`);
  assert.equal(a.run(`state.contacts.get("grp").messages.length`), before, "сообщение не создано");
  assert.ok(!a.run(`!!window.__read`), "файл даже не читался");
  assert.equal(a.run(`__settingsWired`), true, "настройки навешаны один раз");
  a.close();
});

test("B8/A7: параметры сендеров не пересчитываются без причины; пул ICE ограничен", async () => {
  const a = await booted();
  const n = a.run(`(() => {
    let calls = 0; const mk = (id) => ({ track: { id, kind: "audio" }, getParameters: () => ({ encodings: [] }), setParameters: async () => { calls++; } });
    const senders = [mk("a1"), mk("v1")]; senders[1].track.kind = "video";
    const fake = { _closed: false, pc: { getSenders: () => senders, currentLocalDescription: { sdp: "abc" } }, _screenSharing: false, localVideoTrack: null };
    return (async () => { await PeerLink.prototype._tuneSenders.call(fake); await PeerLink.prototype._tuneSenders.call(fake); const first = calls; fake.pc.currentLocalDescription = { sdp: "abcdef" }; await PeerLink.prototype._tuneSenders.call(fake); return [first, calls]; })();
  })()`);
  const [first, total] = await n;
  assert.equal(first, 2, "второй вызов с тем же состоянием ничего не делает");
  assert.equal(total, 4, "после смены SDP — снова");
  assert.ok(a.run(`ICE_POOL_LINKS_MAX`) <= 3);
  a.close();
});
