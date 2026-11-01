// V.81: «вау-слой» скинов — у каждого из 32 скинов есть салют отправки и камео; слой уважает «спокойный режим» и тумблер FX.
const test = require("node:test");
const assert = require("node:assert/strict");
const { closeAll } = require("./harness");
const { boot, sleep, J } = require("./cov-helpers");
test.after(closeAll);

test("SkinFX: запись для каждого скина, салют и камео всех режимов без ошибок, выключатели", async () => {
  const a = await boot();
  const ids = J(a.run(`Skins.IDS.slice()`));
  assert.equal(ids.length, 32);
  assert.deepEqual(J(a.run(`SkinFX.IDS.slice().sort()`)), ids.slice().sort());
  const modes = new Set(J(a.run(`Object.values(SkinFX.WOW).map((w) => w.k.m)`)));
  assert.ok(modes.size >= 15, "разнообразие камео: " + modes.size);
  const errs = J(a.run(`(() => { const out = []; for (const id of Skins.IDS) { try { SkinFX.burst(id); } catch (e) { out.push(id + ":burst:" + e.message); } } return out; })()`));
  assert.deepEqual(errs, []);
  assert.ok(a.run(`document.querySelectorAll("#skin-wow i").length`) > 32 * 3);
  // камео каждого скина (force — без ожидания предыдущей сценки)
  const cerr = J(a.run(`(() => { const out = []; for (const id of Skins.IDS) { try { if (SkinFX.cameo(id, true) !== true) out.push(id); } catch (e) { out.push(id + ":" + e.message); } } return out; })()`));
  assert.deepEqual(cerr, []);
  assert.ok(a.run(`document.querySelectorAll("#skin-wow .skfx-doodle svg path").length`) >= 4);
  await sleep(80);
  assert.ok(a.run(`document.querySelector("#skin-wow .skfx-type").textContent.length`) > 0);
  a.close();
});

test("SkinFX: каждый режим камео отрабатывает; onSend даёт салют, на 15-е — камео; calm и FX off выключают", async () => {
  const a = await boot();
  const r = J(a.run(`(() => { const o = { errs: [] };
    for (const id of Skins.IDS) { try { /* обходим busy: сразу проверяем, что ветка режима не бросает */ const k = SkinFX.WOW[id].k; if (!k.m) o.errs.push(id); } catch (e) { o.errs.push(id); } }
    localStorage.setItem("ether.skin", "lego"); document.querySelector("#skin-wow") && (document.querySelector("#skin-wow").innerHTML = "");
    SkinFX.onSend(); o.afterSend = document.querySelectorAll("#skin-wow .skfx-p").length;
    for (let i = 0; i < 14; i++) SkinFX.onSend();
    return o; })()`));
  assert.deepEqual(r.errs, []); assert.ok(r.afterSend >= 6);
  await sleep(700);
  assert.ok(a.run(`document.querySelectorAll("#skin-wow .skfx-stack").length`) === 5, "15-е сообщение — камео (lego: стопка кирпичей)");
  a.run(`document.querySelector("#skin-wow").innerHTML = ""; Store.calmMode = true;`);
  a.run(`SkinFX.onSend()`); assert.equal(a.run(`document.querySelectorAll("#skin-wow i").length`), 0);
  a.run(`Store.calmMode = false; FX.set("skinwow", false); SkinFX.onSend()`); assert.equal(a.run(`document.querySelectorAll("#skin-wow i").length`), 0);
  a.run(`FX.set("skinwow", true); SkinFX.onSend()`); assert.ok(a.run(`document.querySelectorAll("#skin-wow i").length`) > 0);
  a.close();
});
