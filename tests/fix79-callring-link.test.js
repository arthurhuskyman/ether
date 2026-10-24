// V.79: звонок по ссылке (link-call): формат ссылки, секрет k и HMAC отпечатков, гостевой режим без аккаунта, вход по коду,
// подтверждение создателем со сверочными значками, ошибки. Сервер — мок протокола E (docs/CALL-RELIABILITY-PROTOCOL.md) на настоящем ws,
// WebRTC — настоящий (wrtc) между двумя окнами. Сквозная проверка с реальным сервером — в signaling-server/test-callrings.js (если есть) / tests/fix79-callring-e2e.
// Режим LINKCALL_REAL=1 (tests/fix79-callring-e2e.test.js): вместо мока поднимается настоящий signaling-server/server.js.
const test = require("node:test");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("path");
const wrtc = require("@roamhq/wrtc");
const { createApp, bootApp, closeAll, ROOT } = require("./harness");
const { WebSocketServer } = require(path.join(ROOT, "signaling-server", "node_modules", "ws"));
const { RTCAudioSource } = wrtc.nonstandard;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nb = (x) => String(x).replace(/ /g, " ");
async function until(fn, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(40); } return false; }
const REAL = process.env.LINKCALL_REAL === "1";
const timers = [];
let realServer = null;
test.after(async () => {
  await closeAll();
  for (const t of timers.splice(0)) clearInterval(t);
  try { if (wss) { for (const c of wss.clients) c.terminate(); wss.close(); } if (realServer) realServer.kill(); } catch (e) {}
  setTimeout(() => process.exit(process.exitCode || 0), 1500); // нативные потоки wrtc не дают процессу завершиться сами
});

// ---------- мок сервера (протокол E) ----------
const b64u = (n) => crypto.randomBytes(n).toString("base64url");
const rooms = new Map();
const mock = { errors: {}, log: [] };
let wss, PORT;
function send(ws, o) { try { ws.send(JSON.stringify(o)); } catch (e) {} }
function other(r, ws) { return ws === r.creator ? r.guest : r.creator; }
test.before(async () => {
  if (REAL) {
    PORT = 8799;
    realServer = spawn(process.execPath, [path.join(ROOT, "signaling-server", "server.js")], { env: { ...process.env, PORT: String(PORT), VAPID_PUBLIC: "", VAPID_PRIVATE: "", CLAIMS_PERSIST: "0", MAILBOX_PERSIST: "0", ALIASES_PERSIST: "0", TRUST_PROXY: "", LINKCALL_JOIN_CODE_PER_MIN: "100", LINKCALL_JOIN_ROOM_PER_MIN: "100", LINKCALL_CREATE_PER_MIN: "100" }, stdio: "ignore" });
    await sleep(1500);
    return;
  }
  wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => wss.on("listening", r));
  PORT = wss.address().port;
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(raw); } catch (e) { return; }
      mock.log.push(m.type);
      if (m.type === "register") { ws.registered = true; send(ws, { type: "registered", online: [], features: [], claimed: false }); }
      else if (m.type === "ping") send(ws, { type: "pong" });
      else if (m.type === "linkcall-create") {
        if (mock.errors.create) return send(ws, { type: "linkcall-error", reason: mock.errors.create });
        const room = b64u(16); let code; do { code = String(Math.floor(Math.random() * 900000) + 100000); } while ([...rooms.values()].some((x) => x.code === code));
        rooms.set(room, { room, code, creator: ws, guest: null, allowed: false, signals: [] });
        send(ws, { type: "linkcall-created", room, code, expiresAt: Date.now() + 600000 });
      } else if (m.type === "linkcall-join") {
        if (mock.errors.join) return send(ws, { type: "linkcall-error", reason: mock.errors.join });
        const r = m.room ? rooms.get(m.room) : [...rooms.values()].find((x) => x.code === m.code);
        if (!r) return send(ws, { type: "linkcall-error", reason: "notfound" });
        if (r.guest) return send(ws, { type: "linkcall-error", reason: "full" });
        r.guest = ws; r.guestRef = b64u(6);
        send(r.creator, { type: "linkcall-guest", room: r.room, guestRef: r.guestRef, name: m.name || "", viaCode: !m.room });
        send(ws, { type: "linkcall-joined", room: r.room });
      } else if (m.type === "linkcall-allow") { const r = rooms.get(m.room); if (r && r.creator === ws && m.guestRef === r.guestRef) r.allowed = true; }
      else if (m.type === "linkcall-deny") { const r = rooms.get(m.room); if (r && r.creator === ws) { r.guest = null; r.allowed = false; } }
      else if (m.type === "linkcall-signal") {
        const r = rooms.get(m.room); if (!r || (ws !== r.creator && ws !== r.guest)) return;
        r.signals.push({ from: ws === r.creator ? "creator" : "guest", t: m.data && m.data.t, lcp: m.data && m.data.lcp });
        const to = other(r, ws); if (to) send(to, { type: "linkcall-signal", room: r.room, data: m.data });
      } else if (m.type === "linkcall-end") { const r = rooms.get(m.room); if (r) { const to = other(r, ws); if (to) send(to, { type: "linkcall-end", room: r.room }); rooms.delete(m.room); } }
    });
    ws.on("close", () => { for (const [k, r] of rooms) if (r.creator === ws || r.guest === ws) { const to = other(r, ws); if (to) send(to, { type: "linkcall-end", room: r.room }); rooms.delete(k); } });
  });
});

function installMedia(a) {
  Object.defineProperty(a.window.navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => {
    const src = new RTCAudioSource(); const track = src.createTrack();
    const iv = setInterval(() => src.onData({ samples: new Int16Array(160), sampleRate: 16000, bitsPerSample: 16, channelCount: 1, numberOfFrames: 160 }), 10); timers.push(iv);
    track.addEventListener("ended", () => clearInterval(iv));
    return new wrtc.MediaStream([track]);
  } } });
}
let idN = 0;
const acct = (extra) => ({ "ether.name": "Создатель", "ether.myId": "creator-id-" + (++idN), "ether.lang": "ru", ...(extra || {}), "ether.signalingUrl": "ws://127.0.0.1:" + PORT });
async function creator() {
  const a = createApp({ realWebSocket: true, storage: acct() });
  await a.ready;
  assert.ok(await until(() => a.run(`typeof signaling !== "undefined" && signaling && signaling.registered === true`)), "создатель зарегистрирован на моке");
  installMedia(a);
  return a;
}
const vis = (a, sel) => !a.document.querySelector(sel).classList.contains("hidden");
const txt = (a, sel) => nb(a.document.querySelector(sel).textContent);
async function guestApp(hash, storage) {
  const a = createApp({ realWebSocket: true, url: "http://localhost/" + hash, storage: { "ether.lang": "ru", "ether.signalingUrl": "ws://127.0.0.1:" + PORT, ...(storage || {}) } });
  await a.ready;
  installMedia(a);
  return a;
}
const active = (a) => a.run(`state.callPhase === "active"`);

// ---------- чистая логика: формат, разбор, секрет, HMAC, значки ----------
test("формат ссылки и разбор: #call=<room>.<k>, код из 6 цифр, текст сообщения ровно по протоколу", async () => {
  const a = await bootApp({ storage: { "ether.lang": "ru" } });
  const room = "A".repeat(22), k = "B".repeat(22);
  assert.equal(a.run(`LinkCall.buildLink("https://m.example/", "${room}", "${k}")`), "https://m.example/#call=" + room + "." + k);
  assert.deepEqual({ ...a.run(`LinkCall.parseHash("#call=${room}.${k}")`) }, { room, k });
  assert.deepEqual({ ...a.run(`LinkCall.parseHash("Зовёт: https://m.example/#call=${room}.${k} (действует 10 минут)")`) }, { room, k }, "ссылка внутри текста сообщения");
  for (const bad of ["", "#call=", "#call=short.kkk", "#call=" + room, "#call=" + room + "." + "C".repeat(21), "#answer=1&from=2", "#xcall=" + room + "." + k]) assert.equal(a.run(`LinkCall.parseHash(${JSON.stringify(bad)})`), null, bad);
  assert.equal(a.run(`LinkCall.normalizeCode(" 123 456 ")`), "123456");
  assert.equal(a.run(`LinkCall.normalizeCode("12345")`), null); assert.equal(a.run(`LinkCall.normalizeCode("1234567")`), null);
  assert.deepEqual({ ...a.run(`LinkCall.parseAnswerHash("#answer=c%201&from=ab%2Bc")`) }, { callId: "c 1", from: "ab+c" });
  assert.equal(a.run(`LinkCall.parseAnswerHash("#answer=c1")`), null);
  const text = nb(a.run(`LinkCall.shareText(T("lc.shareText"), "Аня", "https://m.example/#call=X.Y", "123456")`));
  assert.equal(text, "Аня зовёт вас на звонок в The Messenger: https://m.example/#call=X.Y (действует 10 минут). Или введите код 123456 в приложении.");
  const k1 = a.run(`LinkCall.newSecret()`), k2 = a.run(`LinkCall.newSecret()`);
  assert.match(k1, /^[A-Za-z0-9_-]{22}$/); assert.notEqual(k1, k2);
  assert.equal(a.run(`LinkCall.unb64u(k1 = "${k1}").length`), 16, "секрет — 16 байт");
});

test("HMAC(k, локальный|удалённый): вектор совпадает с эталоном Node; порядок и содержимое важны", async () => {
  const a = await bootApp({ storage: { "ether.lang": "ru" } });
  const kBytes = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex"), k = kBytes.toString("base64url");
  const L = "sha-256 aa:bb:cc", R = "sha-256 11:22:33";
  const want = (l, r) => crypto.createHmac("sha256", kBytes).update(l + "|" + r).digest("base64url");
  assert.equal(await a.run(`LinkCall.proof("${k}", "${L}", "${R}")`), want(L, R));
  assert.equal(await a.run(`LinkCall.proof("${k}", "${L}", "")`), want(L, ""), "до согласования удалённого отпечатка — пустая часть");
  assert.notEqual(want(L, R), want(R, L));
  assert.notEqual(await a.run(`LinkCall.proof("${k}", "${L}", "${R}")`), await a.run(`LinkCall.proof("${Buffer.alloc(16, 7).toString("base64url")}", "${L}", "${R}")`));
  assert.equal(a.run(`LinkCall.fingerprintOf("v=0\\r\\na=fingerprint:SHA-256 AB:CD:EF\\r\\n")`), "sha-256 ab:cd:ef");
  assert.equal(a.run(`LinkCall.fingerprintOf("v=0")`), null);
});

test("сверочные значки: 4 штуки, детерминированы по отпечатку, разные отпечатки — разные строки; набор из 64 без повторов", async () => {
  const a = await bootApp({ storage: { "ether.lang": "ru" } });
  const e1 = await a.run(`LinkCall.emojiOf("sha-256 aa")`), e2 = await a.run(`LinkCall.emojiOf("sha-256 aa")`), e3 = await a.run(`LinkCall.emojiOf("sha-256 bb")`);
  assert.equal(e1, e2); assert.notEqual(e1, e3);
  assert.equal(e1.split(" ").length, 4);
  assert.equal(a.run(`LinkCall.EMOJI.length`), 64); assert.equal(a.run(`new Set(LinkCall.EMOJI).size`), 64);
  const h = crypto.createHash("sha256").update("ether-lc-sas|sha-256 aa").digest();
  const em = a.run(`LinkCall.EMOJI`);
  assert.equal(e1, [0, 1, 2, 3].map((i) => em[h[i] % 64]).join(" "));
});

test("signal() к виртуальному собеседнику lc:<room> уходит как linkcall-signal; обычный получатель — как signal", async () => {
  const a = await bootApp({ storage: { "ether.lang": "ru" } });
  a.run(`window.__s = []; signaling.send = (type, p) => { window.__s.push({ type, ...p }); return true; }; signaling.connected = true;`);
  a.run(`signaling.signal("lc:ROOM", { t: "ice" }); signaling.signal("bob", { t: "ice" });`);
  assert.deepEqual(JSON.stringify(a.window.__s.map((x) => x.type)), JSON.stringify(["linkcall-signal", "signal"]));
  assert.equal(a.window.__s[0].room, "ROOM");
});

// ---------- сквозные сценарии на моке ----------
test("ссылка с секретом: гость без аккаунта (гостевой режим) входит, создатель авто-разрешает по HMAC, звонок активен с обеих сторон; ничего не сохраняется", async () => {
  const c = await creator();
  const e = await c.run(`linkCallCreateAndShare({ forId: null, forName: "Боря" })`);
  assert.ok(e && e.room && /^\d{6}$/.test(e.code));
  assert.ok(vis(c, "#linkcall-wait-sheet"));
  assert.equal(txt(c, "#linkcall-wait-title"), "Ждём Боря");
  assert.match(txt(c, "#linkcall-wait-code"), /Код: \d{6}/);
  const link = c.run(`lcWaiting.link`);
  assert.match(link, /#call=[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{22}$/);

  const g = await guestApp(link.slice(link.indexOf("#")));
  assert.ok(vis(g, "#guest-call"), "минимальный экран гостя");
  assert.ok(!vis(g, "#onboarding") && !vis(g, "#lock-screen"), "без онбординга");
  assert.equal(g.run(`state.guestMode`), true);
  assert.ok(vis(g, "#guest-call-name") && vis(g, "#guest-call-join-btn"));
  assert.equal(g.window.location.hash, "", "секрет убран из адресной строки");
  g.document.querySelector("#guest-call-name").value = "Гоша";
  g.document.querySelector("#guest-call-join-btn").click();

  assert.ok(await until(() => active(c) && active(g), 20000), "звонок активен у обоих");
  assert.ok(!vis(g, "#guest-call"), "панель гостя скрыта, виден экран звонка");
  assert.ok(vis(g, "#call-screen") && vis(c, "#call-screen"));
  assert.ok(!vis(c, "#linkcall-approve-sheet"), "авто-разрешение: окна подтверждения нет");
  assert.equal(txt(c, "#call-peer-name"), "Гоша", "имя гостя из его поля");
  // доказательства секрета реально ходили по сигналам, а секрет k — нет
  if (!REAL) {
    const room = rooms.get(e.room);
    assert.ok(room.signals.some((s) => s.from === "guest" && s.t === "offer" && s.lcp), "offer гостя несёт HMAC");
    assert.ok(room.signals.some((s) => s.from === "creator" && s.t === "answer" && s.lcp), "answer создателя несёт HMAC");
    assert.ok(!JSON.stringify(room.signals).includes(e.k), "секрет k по серверу не проходил");
  }
  // гость ничего не сохранил
  const ls = g.window.localStorage; const keys = []; for (let i = 0; i < ls.length; i++) keys.push(ls.key(i));
  assert.ok(!keys.includes("ether.name") && !keys.includes("ether.myId") && !keys.includes("ether.contacts") && !keys.includes("ether.callLog"), "идентичность и журнал не сохранены: " + keys.join(","));
  // виртуальный собеседник не попадает в чаты
  assert.equal(c.run(`Array.from(state.contacts.values()).filter((x) => !x.ephemeral).length`), c.run(`state.contacts.size - 1`));
  assert.ok(!c.document.querySelector("#chats-list").textContent.includes("Гоша"));
  // завершение создателем: у гостя «Звонок завершён», виртуальные контакты и комната убраны
  c.document.querySelector("#call-hangup-btn").click();
  assert.ok(await until(() => g.run(`state.callId`) === null), "гость увидел завершение");
  assert.ok(await until(() => vis(g, "#guest-call") && txt(g, "#guest-call-status") === "Звонок завершён"), "экран «Звонок завершён»");
  assert.equal(c.run(`state.contacts.has("lc:" + ${JSON.stringify(e.room)})`), false);
  assert.equal(c.run(`lcRooms.size`), 0);
  assert.equal(g.run(`state.contacts.size`), 0);
});

test("вход по коду из главного меню: создатель видит «Кто-то подключился» с теми же 4 значками, что и гость; «Впустить» — звонок идёт", async () => {
  const c = await creator();
  const e = await c.run(`linkCallCreateAndShare({ forName: "Вика" })`);
  const g = createApp({ realWebSocket: true, storage: { "ether.name": "Гость-аккаунт", "ether.myId": "guest-acc-id-" + (++idN), "ether.lang": "ru", "ether.signalingUrl": "ws://127.0.0.1:" + PORT } });
  await g.ready; assert.ok(await until(() => g.run(`signaling && signaling.registered === true`))); installMedia(g);
  for (const sel of ["#chats-empty-join-btn", "#connect-join-code-btn"]) assert.ok(g.document.querySelector(sel), "точка входа " + sel);
  assert.equal(nb(g.document.querySelector("#chats-empty-join-btn").textContent), "Присоединиться к звонку по коду");
  g.document.querySelector("#chats-empty-join-btn").click();
  assert.ok(vis(g, "#linkcall-join-sheet"));
  g.document.querySelector("#linkcall-code-input").value = "12";
  g.document.querySelector("#linkcall-join-go").click();
  assert.equal(txt(g, "#linkcall-join-error"), "Введите 6 цифр", "короткий код не отправляется");
  g.document.querySelector("#linkcall-code-input").value = e.code;
  g.document.querySelector("#linkcall-join-go").click();

  assert.ok(await until(() => vis(c, "#linkcall-approve-sheet")), "создатель просит подтверждение (секрета у гостя нет)");
  assert.ok(!vis(c, "#call-screen"), "без подтверждения звонка нет");
  assert.match(txt(c, "#linkcall-approve-text"), /Кто-то подключился по коду \(Гость-аккаунт\)/);
  const sasC = txt(c, "#linkcall-approve-sas").split(" ");
  assert.equal(sasC.length, 4, "4 значка");
  assert.ok(await until(() => g.run(`document.getElementById("guest-call-sas").textContent`).length > 3));
  const sasG = txt(g, "#guest-call-sas");
  for (const em of sasC) assert.ok(sasG.includes(em), "гость видит те же значки: " + sasG + " / " + sasC.join(" "));
  assert.ok(c.run(`!!lcRooms.get(${JSON.stringify(e.room)}).offer`), "offer удержан шлюзом до подтверждения");
  assert.equal(c.run(`mesh.get("lc:" + ${JSON.stringify(e.room)}) === undefined`), true, "P2P-линк до подтверждения не создан (IP не раскрыт)");
  c.document.querySelector("#linkcall-approve-allow").click();
  assert.ok(await until(() => active(c) && active(g), 20000), "звонок активен");
  assert.equal(txt(c, "#call-peer-name"), "Гость-аккаунт");
  g.document.querySelector("#call-hangup-btn").click();
  assert.ok(await until(() => c.run(`state.callId`) === null), "создатель видит завершение");
});

test("создатель отклонил вход по коду: комната снова ждёт, звонка нет, гость может быть заменён настоящим", async () => {
  const c = await creator();
  const e = await c.run(`linkCallCreateAndShare({ forName: "Вика" })`);
  const g = createApp({ realWebSocket: true, storage: { "ether.name": "Чужой", "ether.myId": "stranger-" + (++idN), "ether.lang": "ru", "ether.signalingUrl": "ws://127.0.0.1:" + PORT } });
  await g.ready; assert.ok(await until(() => g.run(`signaling && signaling.registered === true`)));
  g.run(`linkCallGuestStart({ code: ${JSON.stringify(e.code)} })`);
  assert.ok(await until(() => vis(c, "#linkcall-approve-sheet")));
  c.document.querySelector("#linkcall-approve-deny").click();
  assert.ok(!vis(c, "#linkcall-approve-sheet")); assert.ok(vis(c, "#linkcall-wait-sheet"), "снова «Ждём …»");
  assert.equal(c.run(`state.callId`), null);
  assert.equal(c.run(`lcRooms.get(${JSON.stringify(e.room)}).status`), "waiting");
});

test("неверный секрет в ссылке: создатель отклоняет автоматически, звонка нет, показано «не удалось проверить ссылку»", async () => {
  const c = await creator();
  const e = await c.run(`linkCallCreateAndShare({ forName: "Вика" })`);
  c.run(`window.__toasts = []; { const orig = toast; toast = (m) => { window.__toasts.push(m); return orig(m); }; }`);
  const wrongK = crypto.randomBytes(16).toString("base64url");
  const g = await guestApp("#call=" + e.room + "." + wrongK);
  g.document.querySelector("#guest-call-join-btn").click();
  if (REAL) await sleep(1500); else assert.ok(await until(() => rooms.get(e.room).signals.length > 0));
  assert.ok(await until(() => c.run(`lcRooms.get(${JSON.stringify(e.room)}).status`) === "waiting"));
  await sleep(300);
  assert.equal(c.run(`state.callId`), null);
  assert.ok(!vis(c, "#linkcall-approve-sheet"), "поддельная ссылка не получает даже окна подтверждения");
  assert.ok(await until(() => c.window.__toasts.some((m) => /Не удалось проверить ссылку/.test(nb(m)))), "toast об ошибке проверки: " + c.window.__toasts.join("|"));
});

test("ошибки входа: устарела / занято / не найдено / много попыток — понятные экраны гостя без утечек", async () => {
  const map = { expired: "Ссылка устарела. Попросите отправить новую.", full: "В этом звонке уже есть собеседник.", notfound: "Звонок не найден. Проверьте ссылку или код.", ratelimit: "Слишком много попыток. Подождите минуту." };
  for (const [reason, text] of Object.entries(map)) {
    if (REAL) { if (reason !== "notfound") continue; } else mock.errors.join = reason;
    const roomForLoop = "R".repeat(22);
    const g = await guestApp("#call=" + "R".repeat(22) + "." + "K".repeat(22));
    g.document.querySelector("#guest-call-join-btn").click();
    assert.ok(await until(() => txt(g, "#guest-call-status") === text), reason + ": " + txt(g, "#guest-call-status"));
    assert.ok(vis(g, "#guest-call-close-btn") && !vis(g, "#guest-call-join-btn") && !vis(g, "#guest-call-name"));
    if (!REAL) delete mock.errors.join;
  }
  // настоящая комната, занятая другим гостем -> full
  const c = await creator(); const e = await c.run(`linkCallCreateAndShare({})`);
  const g1 = createApp({ realWebSocket: true, storage: { "ether.name": "Первый", "ether.myId": "first-" + (++idN), "ether.lang": "ru", "ether.signalingUrl": "ws://127.0.0.1:" + PORT } }); await g1.ready;
  assert.ok(await until(() => g1.run(`signaling && signaling.registered === true`)));
  g1.run(`linkCallGuestStart({ code: ${JSON.stringify(e.code)} })`);
  assert.ok(await until(() => vis(c, "#linkcall-approve-sheet")));
  const g2 = await guestApp("#call=" + e.room + "." + e.k); g2.document.querySelector("#guest-call-join-btn").click();
  assert.ok(await until(() => txt(g2, "#guest-call-status") === map.full));
});

test("создателю: ошибка linkcall-create (слишком много ссылок) — понятное сообщение, окна ожидания нет", { skip: REAL }, async () => {
  const c = await creator();
  mock.errors.create = "toomany";
  const r = await c.run(`linkCallCreateAndShare({})`);
  delete mock.errors.create;
  assert.equal(r, null);
  assert.ok(!vis(c, "#linkcall-wait-sheet"));
  assert.match(nb(c.document.querySelector("#toast").textContent), /Слишком много активных ссылок/);
});

test("«Позвать другим способом» с экрана звонка: звонок обрывается, создаётся ссылка, share получает текст по протоколу", async () => {
  const c = await creator();
  c.run(`ensureContactEntry("alice", "Алиса")`);
  c.run(`window.__shared = []; Object.defineProperty(navigator, "share", { configurable: true, value: async (d) => { window.__shared.push(d); } });`);
  c.run(`window.__sent = []; const o = signaling.signal.bind(signaling); signaling.signal = (to, d) => { window.__sent.push({ to, d }); return o(to, d); };`);
  c.run(`onlineSet.add("alice")`);
  await c.run(`beginCall("alice", false)`);
  assert.equal(c.run(`state.callId`), "alice");
  c.document.querySelector("#call-alt-link-btn").click();
  assert.equal(c.run(`state.callId`), null, "исходящий вызов отменён");
  assert.ok(c.run(`window.__sent`).some((x) => x.d && x.d.t === "call-ended" && x.to === "alice"));
  assert.ok(await until(() => c.window.__shared.length === 1));
  const text = nb(c.window.__shared[0].text);
  assert.match(text, /^Создатель зовёт вас на звонок в The Messenger: http\S+#call=[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{22} \(действует 10 минут\)\. Или введите код \d{6} в приложении\.$/);
  assert.equal(txt(c, "#linkcall-wait-title"), "Ждём Алиса");
});

test("без navigator.share: ссылка копируется в буфер, код виден на экране ожидания", async () => {
  const c = await creator();
  c.run(`window.__clip = []; Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t) => { window.__clip.push(t); } } });`);
  await c.run(`linkCallCreateAndShare({ forName: "Вика" })`);
  assert.ok(await until(() => c.window.__clip.length === 1));
  assert.match(c.window.__clip[0], /#call=/);
  assert.match(txt(c, "#linkcall-wait-code"), /\d{6}/);
  c.document.querySelector("#linkcall-wait-cancel").click();
  assert.ok(!vis(c, "#linkcall-wait-sheet")); assert.equal(c.run(`lcRooms.size`), 0);
});

test("входящее сообщение в обход шлюза: гость не может подсунуть чат/файлы через канал данных (ephemeral принимает только состояние звонка)", async () => {
  const a = await bootApp({ storage: { "ether.lang": "ru" } });
  a.run(`state.contacts.set("lc:X", { id: "lc:X", name: "Г", managed: false, ephemeral: true, messages: [], publicKey: null })`);
  a.run(`mesh.dispatchEvent(new CustomEvent("message", { detail: { id: "lc:X", payload: { kind: "chat", id: "m1", text: "привет" } } }))`);
  assert.equal(a.run(`state.contacts.get("lc:X").messages.length`), 0);
});
