// V.80: большие файлы на уровне приложения — два окна (jsdom) с настоящими PeerLink/RTCDataChannel (wrtc): согласование filebin1 в ping/pong,
// отправка 1:1 из sendFileMessage, приём в ленту, хранилище IndexedDB, прогресс-пузырь (aria), удаление; совместимость со «старым» пиром:
// малые файлы идут прежним JSON/base64-путём в обе стороны, большой файл старому пиру отклоняется с понятным сообщением.
const test = require("node:test");
const assert = require("node:assert/strict");
const { bootApp, closeAll } = require("./harness");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000, step = 50) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(step); } return false; }
const clone = (x) => JSON.parse(JSON.stringify(x));
test.after(async () => { await closeAll(); setTimeout(() => process.exit(process.exitCode || 0), 800); });

async function pair(stripFbOnB) {
  const A = await bootApp({ storage: { "ether.name": "Alice", "ether.myId": "alice-id" } });
  const B = await bootApp({ storage: { "ether.name": "Bob", "ether.myId": "bob-id" } });
  for (const w of [A, B]) w.window.CSS = w.window.CSS || { escape: (x) => String(x) }; // в jsdom нет CSS.escape (его зовёт прежний путь sendFile)
  A.run(`ensureContactEntry("bob-id", "Bob"); persistContacts();`); B.run(`ensureContactEntry("alice-id", "Alice"); persistContacts();`);
  const la = A.run(`mesh.createOutgoingLink("bob-id")`), lb = B.run(`mesh.createIncomingLink("alice-id")`);
  if (stripFbOnB) { const proto = Object.getPrototypeOf(lb); lb.send = (p) => { if (p && p.fb) { p = Object.assign({}, p); delete p.fb; } return proto.send.call(lb, p); }; }
  la.addEventListener("ice-candidate", (e) => lb.addIceCandidate(clone(e.detail.candidate)));
  lb.addEventListener("ice-candidate", (e) => la.addIceCandidate(clone(e.detail.candidate)));
  const offer = await la.createInitialOffer("room"); const ans = await lb.acceptOfferAndCreateAnswer(clone(offer)); await la.acceptAnswer(clone(ans));
  assert.ok(await until(() => la.dc && la.dc.readyState === "open" && lb.dc && lb.dc.readyState === "open", 20000), "канал данных открыт");
  return { A, B, la, lb };
}
const msg = (w, peer, id) => w.run(`(state.contacts.get(${JSON.stringify(peer)}).messages.find((m) => ${id ? `m.id === ${JSON.stringify(id)}` : "m.file"}))`);
const mk = (w, name, n, fill) => w.run(`(() => { const u = new Uint8Array(${n}); for (let i = 0; i < u.length; i++) u[i] = (i * 31 + ${fill}) & 255; const f = new File([u], ${JSON.stringify(name)}, { type: "application/octet-stream" }); f.arrayBuffer = async () => u.buffer.slice(0); return f; })()`); // jsdom: у File нет arrayBuffer()

test("filebin1: возможность обнаруживается по ping/pong; большой файл A→B и B→A доходит целым, лента и aria-прогресс корректны", async () => {
  const { A, B, la, lb } = await pair(false);
  assert.ok(await until(() => la.peerFileBin === true && lb.peerFileBin === true, 8000), "оба видят filebin1");
  const SZ = 5 * 1024 * 1024 + 321;
  A.window.__f = mk(A, "film.mkv", SZ, 7);
  await A.run(`sendFileMessage("bob-id", __f)`);
  const sent = msg(A, "bob-id"); assert.ok(sent.file.big && sent.file.pending, "сообщение сразу в ленте, в ожидании");
  const html = A.run(`fileBubbleHtml(${JSON.stringify(sent.id)}, state.contacts.get("bob-id").messages[0].file)`);
  assert.match(html, /role="progressbar"/); assert.match(html, /aria-valuenow="\d+"/); assert.match(html, /data-big-act="cancel"/);
  assert.ok(await until(() => { const m = msg(B, "alice-id", sent.id); return m && m.file && !m.file.pending && !m.file.failed; }, 40000), "получатель завершил приём");
  assert.ok(await until(() => !msg(A, "bob-id", sent.id).file.pending, 10000)); assert.equal(msg(A, "bob-id", sent.id).ack, "sent"); assert.equal(msg(A, "bob-id", sent.id).file.failed, undefined);
  const got = msg(B, "alice-id", sent.id); assert.equal(got.file.size, SZ); assert.equal(got.file.name, "film.mkv"); assert.equal(got.file.bigStore, "idb");
  const sum = await B.run(`(async () => { const b = await bigHub.getBlob(${JSON.stringify(sent.id)}); const u = new Uint8Array(await b.arrayBuffer()); let h = 0; for (let i = 0; i < u.length; i++) h = (h * 33 + u[i]) >>> 0; return [u.length, h]; })()`);
  const exp = (() => { let h = 0; for (let i = 0; i < SZ; i++) h = (Math.imul(h, 33) + ((i * 31 + 7) & 255)) >>> 0; return [SZ, h]; })();
  assert.deepEqual([...sum], exp, "байты совпали");
  // скачивание по blob-URL из ленты работает через движок
  assert.ok(await B.run(`getFileBlobUrl(${JSON.stringify(sent.id)}).then((u) => !!u)`));
  // обратное направление
  B.window.__g = mk(B, "back.bin", 3 * 1024 * 1024, 9); await B.run(`sendFileMessage("alice-id", __g)`);
  assert.ok(await until(() => { const m = msg(A, "bob-id"); const x = A.run(`state.contacts.get("bob-id").messages.filter((m) => m.from === "them" && m.file)`); return x.length && !x[0].file.pending && !x[0].file.failed; }, 40000), "B→A доехал");
  // удаление сообщения освобождает хранилище
  B.run(`deleteMessageLocal("alice-id", ${JSON.stringify(sent.id)})`);
  assert.ok(await until(async () => (await B.run(`bigHub.getBlob(${JSON.stringify(sent.id)})`)) === null, 5000));
});

test("старый пир (без fb): малые файлы по прежнему JSON/base64 в обе стороны, большой отклоняется с причиной peer-old", async () => {
  const { A, B, la, lb } = await pair(true);
  await sleep(1500); assert.equal(la.peerFileBin, undefined, "старый пир возможность не объявляет"); assert.equal(lb.peerFileBin, true, "новый видит новое только от нового");
  A.run(`window.__linkSends = 0; (() => { const l = mesh.get("bob-id"); const o = l.sendFile.bind(l); l.sendFile = (...a) => { window.__linkSends++; return o(...a); }; })()`);
  A.window.__s = mk(A, "small.bin", 100000, 1); await A.run(`sendFileMessage("bob-id", __s)`);
  assert.ok(await until(() => { const m = msg(B, "alice-id"); return m && m.file && !m.file.pending && !m.file.failed; }, 20000), "малый файл A→B дошёл старым путём " + JSON.stringify([A.run(`state.contacts.get("bob-id").messages.map((m) => m.file)`), B.run(`state.contacts.get("alice-id").messages.map((m) => m.file)`), A.window.__linkSends]));
  assert.equal(A.window.__linkSends, 1, "использован link.sendFile (JSON/base64), не бинарный движок");
  assert.equal(A.run(`bigHub === null`), true, "движок для малого файла даже не создаётся");
  B.window.__s2 = mk(B, "small2.bin", 80000, 2); await B.run(`sendFileMessage("alice-id", __s2)`);
  assert.ok(await until(() => { const x = A.run(`state.contacts.get("bob-id").messages.filter((m) => m.from === "them" && m.file)`); return x.length && !x[0].file.pending && !x[0].file.failed; }, 20000), "малый файл B→A дошёл");
  // большой файл старому пиру: через ~6 с — отказ peer-old, без зависшего «в процессе»
  A.window.__b = mk(A, "huge.bin", 4 * 1024 * 1024, 3); await A.run(`sendFileMessage("bob-id", __b)`);
  const big = A.run(`state.contacts.get("bob-id").messages.find((m) => m.file && m.file.big)`).id;
  assert.ok(await until(() => { const m = msg(A, "bob-id", big); return m.file.failed; }, 15000, 100), "большой файл отклонён");
  const f = msg(A, "bob-id", big); assert.equal(f.file.failReason, "peer-old"); assert.equal(f.file.pending, false); assert.equal(f.ack, "failed");
});
