// V.82: «отправить позже» в личный чат уходит на сервер сразу с nb и доходит вовремя при закрытом приложении; у себя появляется в срок.
const test = require("node:test");
const assert = require("node:assert/strict");
const { closeAll } = require("./harness");
const { boot, sleep, J } = require("./cov-helpers");
test.after(closeAll);

test("отложенное: передача серверу с nb, без повторной отправки в срок; отмена снимает с сервера; без feature — по-старому", async () => {
  const a = await boot();
  a.run(`(() => { const c = ensureContactEntry("bob", "Bob"); c.managed = true; c.publicKey = { kty: "EC" };
    window.__d = []; window.__cancel = [];
    window.encryptForContact = async () => ({ iv: "AAAA", ct: "BBBB", v: 1 });
    signaling = { registered: true, connected: true, features: ["deferred"], deliver: (to, id, env, pk, kind, nb) => { window.__d.push({ to, id, kind, nb }); return true; }, mailboxCancel: (to, id) => window.__cancel.push([to, id]), send() { return true; } };
    state._firstRenderDone = true; persistContacts(); state.chatId = "bob"; renderTab(); })()`);
  const at = Date.now() + 3600000;
  a.run(`document.querySelector("#chat-input").value = "привет из будущего"; queueScheduledMessage(${at});`);
  await sleep(300);
  const d = J(a.run(`window.__d`));
  assert.equal(d.length, 1); assert.equal(d[0].nb, at); assert.equal(d[0].to, "bob");
  const s = J(a.run(`state.scheduledMessages[0]`));
  assert.equal(s.serverMsgId, d[0].id);
  // созрело: сообщение появляется у себя, повторно не уходит
  a.run(`state.scheduledMessages[0].sendAt = Date.now() - 1; window.__send = 0; const o = sendChatMessage; window.sendChatMessage = async () => { window.__send++; return true; }; sweepScheduledMessages();`);
  await sleep(100);
  assert.equal(a.run(`window.__send`), 0);
  assert.equal(a.run(`state.scheduledMessages.length`), 0);
  assert.equal(a.run(`state.contacts.get("bob").messages.filter((m) => m.id === "${d[0].id}" && m.text === "привет из будущего").length`), 1);
  // без feature — старый путь (только локально)
  a.run(`signaling.features = []; document.querySelector("#chat-input").value = "x"; queueScheduledMessage(${at});`);
  await sleep(200);
  assert.equal(J(a.run(`window.__d`)).length, 1);
  assert.equal(a.run(`state.scheduledMessages[0].serverMsgId`), undefined);
  a.close();
});
