// V.81: офлайн-файлы 2–16 МБ частями через ящик (kind "fpart"): лимиты, отправка, сборка в любом порядке, проверка хэша, защита от мусора.
const test = require("node:test");
const assert = require("node:assert/strict");
const { closeAll } = require("./harness");
const { boot, sleep, J } = require("./cov-helpers");
const L = require("../js/file-limits.js");
test.after(closeAll);

test("лимиты частей: число частей выводится из размера, номер в пределах, длина последней части", () => {
  assert.equal(L.OFFLINE_MAX_PARTS, 11);
  const size = 3 * 1024 * 1024 + 5;
  assert.equal(L.isValidFilePartMeta({ size, parts: 3, part: 2 }), true);
  assert.equal(L.isValidFilePartMeta({ size, parts: 4, part: 0 }), false);
  assert.equal(L.isValidFilePartMeta({ size, parts: 3, part: 3 }), false);
  assert.equal(L.isValidFilePartMeta({ size: L.OFFLINE_MAX_FILE_SIZE + 1, parts: 11, part: 0 }), false);
  assert.equal(L.isValidFilePartMeta({ size: "5", parts: 1, part: 0 }), false);
  assert.equal(L.filePartLength(size, 2), size - 2 * L.OFFLINE_PART_SIZE);
  assert.equal(L.filePartLength(size, 0), L.OFFLINE_PART_SIZE);
});

async function waitFor(fn, ms = 4000) { for (let i = 0; i < ms / 50; i++) { if (fn()) return true; await sleep(50); } return false; }

test("отправка 3,2 МБ офлайн: 3 части с хэшем; получатель собирает в обратном порядке; повтор и подмена отвергаются", async () => {
  const s = await boot();
  s.run(`(() => { const c = ensureContactEntry("bob", "Bob"); c.managed = true; window.__parts = []; window.trySendOrQueue = async (c, id, p) => { window.__parts.push([id, p]); }; state._firstRenderDone = true; persistContacts(); })()`);
  await s.run(`(async () => { const u = new Uint8Array(3200 * 1024); for (let i = 0; i < u.length; i++) u[i] = (i * 31 + 7) & 255; await sendFileOfflineParts("bob", new File([u], "big.bin", { type: "application/octet-stream" }), { caption: "cap" }); })()`);
  const parts = J(s.run(`window.__parts`));
  assert.equal(parts.length, 3);
  assert.deepEqual(parts.map((x) => x[0].split(".p")[1]), ["0", "1", "2"]);
  assert.ok(parts.every((x) => x[1].kind === "fpart" && x[1].parts === 3 && /^[0-9a-f]{64}$/.test(x[1].h) && x[1].size === 3200 * 1024));
  assert.equal(parts[0][1].caption, "cap"); assert.equal(parts[1][1].caption, undefined);
  // в сохранённой очереди base64 не хранится, а восстанавливается срезом блоба
  const slim = J(s.run(`slimPayload(window.__parts[1][1])`));
  assert.equal(slim.dataB64, undefined); assert.equal(slim.idbOff, L.OFFLINE_PART_SIZE);
  const hydrated = await s.run(`hydratePayload(slimPayload(window.__parts[1][1])).then((p) => p && p.dataB64 === window.__parts[1][1].dataB64)`);
  assert.equal(hydrated, true);
  const own = J(s.run(`state.contacts.get("bob").messages.at(-1).file`));
  assert.equal(own.pending, false);

  const r = await boot();
  r.run(`(() => { const c = ensureContactEntry("alice", "Alice"); c.managed = true; state._firstRenderDone = true; persistContacts(); })()`);
  const id = parts[0][1].id;
  // мусор: неверный номер части, неверная длина, хэш не hex
  await r.run(`receiveFilePart("alice", Object.assign({}, ${JSON.stringify(parts[2][1])}, { part: 5 }), "e0")`);
  await r.run(`receiveFilePart("alice", Object.assign({}, ${JSON.stringify(parts[2][1])}, { dataB64: "AAAA" }), "e0")`);
  await r.run(`receiveFilePart("alice", Object.assign({}, ${JSON.stringify(parts[2][1])}, { h: "zz" }), "e0")`);
  assert.equal(r.run(`state.contacts.get("alice").messages.filter((m) => m.id === "${id}").length`), 0);
  for (const i of [2, 0]) await r.run(`receiveFilePart("alice", ${JSON.stringify(parts[i][1])}, "e${i}")`);
  const mid = J(r.run(`state.contacts.get("alice").messages.find((m) => m.id === "${id}").file`));
  assert.equal(mid.pending, true); assert.equal(mid.got.length, 2); assert.equal(mid.caption, "cap");
  await r.run(`receiveFilePart("alice", ${JSON.stringify(parts[1][1])}, "e1")`);
  assert.ok(await waitFor(() => r.run(`(() => { const m = state.contacts.get("alice").messages.find((m) => m.id === "${id}"); return m && !m.file.pending; })()`)));
  const done = J(r.run(`state.contacts.get("alice").messages.find((m) => m.id === "${id}").file`));
  assert.equal(done.got, undefined); assert.equal(done.failed, undefined); assert.equal(done.size, 3200 * 1024);
  const sameBytes = await r.run(`IDB.get("file:${id}").then((b) => b.arrayBuffer()).then((ab) => { const u = new Uint8Array(ab); if (u.length !== 3200 * 1024) return false; for (let i = 0; i < u.length; i += 4099) if (u[i] !== ((i * 31 + 7) & 255)) return false; return true; })`);
  assert.equal(sameBytes, true);
  // повтор части из ящика после сборки ничего не меняет
  await r.run(`receiveFilePart("alice", ${JSON.stringify(parts[0][1])}, "e0")`);
  assert.equal(r.run(`state.contacts.get("alice").messages.filter((m) => m.id === "${id}").length`), 1);

  // подмена: те же части с чужим хэшем у нового id -> собирается, но хэш не сходится -> failed
  const fake = parts.map((x) => Object.assign({}, x[1], { id: "fakefile-0001", h: "0".repeat(64) }));
  for (const p of fake) await r.run(`receiveFilePart("alice", ${JSON.stringify(p)}, "x")`);
  assert.ok(await waitFor(() => r.run(`(() => { const m = state.contacts.get("alice").messages.find((m) => m.id === "fakefile-0001"); return m && m.file.failed === true; })()`)));
  assert.equal(await r.run(`IDB.get("file:fakefile-0001").then((b) => !!b)`), false);
  s.close(); r.close();
});
