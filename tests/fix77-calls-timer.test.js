// Таймер звонка после часа: «1:37:28», а не «97:28» (жалоба: «когда больше часа говоришь в звонке, он не пишет часы»).
const test = require("node:test");
const assert = require("node:assert/strict");
const { bootApp, closeAll } = require("./harness");
test.after(closeAll);

test("formatClock / formatDuration: до часа мм:сс, от часа ч:мм:сс", async () => {
  const a = await bootApp({ platform: "desktop" });
  const f = (ms) => a.run(`formatClock(${ms})`), d = (ms) => a.run(`formatDuration(${ms})`);
  assert.equal(f(0), "00:00");
  assert.equal(f(59000), "00:59");
  assert.equal(f(61000), "01:01");
  assert.equal(f(3599000), "59:59");
  assert.equal(f(3600000), "1:00:00");
  assert.equal(f((97 * 60 + 28) * 1000), "1:37:28", "ровно случай из жалобы: 97 минут 28 секунд");
  assert.equal(f(10 * 3600000 + 5 * 60000 + 9000), "10:05:09");
  assert.equal(f(-5), "00:00");
  assert.equal(a.run(`formatClock("junk")`), "00:00");
  // история звонков / сообщения «Звонок завершён»: тот же формат от часа
  assert.equal(d((97 * 60 + 28) * 1000), "1:37:28");
  assert.equal(d(3600000), "1:00:00");
  assert.equal(d(125000), "2:05");
  assert.match(d(7000), /7/);
  assert.doesNotMatch(d(NaN), /NaN/);
  a.close();
});

test("таймер экрана звонка и мини-плашки показывает часы", async () => {
  const a = await bootApp({ platform: "desktop" });
  a.run(`ensureContactEntry("alice", "Alice"); state.callId = "alice"; state.callPhase = "active";`);
  a.run(`paintCallTimer(Date.now() - ((97 * 60 + 28) * 1000))`);
  assert.equal(a.document.querySelector("#call-phase").textContent, "1:37:28");
  assert.equal(a.document.querySelector("#mini-call-timer").textContent, "1:37:28");
  a.run(`paintCallTimer(Date.now() - 65000)`);
  assert.equal(a.document.querySelector("#call-phase").textContent, "01:05");
  a.run(`state.callId = null; state.callPhase = null;`);
  a.close();
});

test("секундный тик startCallTimer пишет тот же формат (раньше собственная копия mm:ss без часов)", async () => {
  const a = await bootApp({ platform: "desktop" });
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "js/app/12-calls-search.js"), "utf8");
  assert.doesNotMatch(src, /String\(Math\.floor\(secs \/ 60\)\)\.padStart/, "ручного mm:ss без часов не должно остаться");
  a.close();
});

test("таймер группового звонка", async () => {
  const a = await bootApp({ platform: "desktop" });
  const el = a.document.createElement("span"); el.id = "gcall-timer"; a.document.body.appendChild(el);
  a.run(`GC.startedAt = Date.now() - ((97 * 60 + 28) * 1000); gcallTick();`);
  assert.equal(el.textContent, "1:37:28");
  a.close();
});
