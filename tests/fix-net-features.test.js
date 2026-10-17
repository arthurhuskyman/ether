// Голосовые комнаты: флаг комнаты, присутствие, тихий вход без приглашения, выход, истечение записей, права на флаг.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closeAll } = require("./harness");
test.after(closeAll);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function booted() {
  const a = createApp({ storage: { "ether.name": "Я", "ether.myId": "me-test-id", "ether.lang": "ru" } });
  await a.ready;
  for (let i = 0; i < 60 && !a.run(`typeof __appStarted !== "undefined" && __appStarted`); i++) await sleep(50);
  return a;
}
test("fix-net: «пока» только в прощании; системные сообщения не в экспорте; тихие часы глушат сигнатуру", async () => {
  const a = await booted();
  assert.equal(a.run(`FX_GOODBYE.test("пока не знаю")`), false);
  assert.equal(a.run(`FX_GOODBYE.test("ну всё, пока!")`), true);
  a.run(`const c = ensureContactEntry("zed", "Зед"); c.messages = [{ id: "1", from: "me", text: "привет", ts: Date.now() }, { id: "2", from: "system", text: "служебное", ts: Date.now() }];`);
  const exp = await a.run(`buildSignedExport("zed")`);
  assert.equal(exp.messages.length, 1, "from:system не попадает в подписанный экспорт");
  a.run(`window.quietNow = () => true; Store.soundsEnabled = true; FX.set("sonic", true)`);
  assert.equal(a.run(`playSonicSignature("zed")`), false, "в тихие часы сигнатура молчит");
  a.close();
});
