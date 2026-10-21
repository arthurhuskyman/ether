// Регрессия аудита V.76 (раздел 1, S1–S9): '#' в id, push о звонке, /link/put до чтения тела, квота каналов, глобальный потолок неудач,
// кэш картинок превью, TRUST_PROXY по умолчанию выключен, потоковое сохранение ящика, чужой активный phone-hash не перезаписывается.
const { spawn } = require("child_process");
const WebSocket = require("ws");
const http = require("http");
const net = require("net");
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");
let pass = 0, fail = 0;
function check(label, cond) { if (cond) { pass++; console.log("  OK   " + label); } else { fail++; console.log("  FAIL " + label); } }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const id = (c) => c.repeat(64);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ether-a76-"));
const procs = [];
process.on("exit", () => procs.forEach((p) => { try { p.kill("SIGKILL"); } catch (e) {} }));
let nextPort = 8851;
function start(env, preload) {
  const port = nextPort++; let out = "";
  const p = spawn(process.execPath, (preload ? ["--require", preload] : []).concat([path.join(__dirname, "server.js")]), {
    env: Object.assign({}, process.env, { PORT: String(port), MAILBOX_PERSIST: "0", CLAIMS_PERSIST: "0", VAPID_PUBLIC: "", VAPID_PRIVATE: "", REGISTER_DEADLINE_MS: "60000", PUSH_SUBS_FILE: path.join(tmp, "subs-" + port + ".json"), DISCOVERY_FILE: path.join(tmp, "disc-" + port + ".json"), DISCOVERY_MIN_MS: "50" }, env || {}),
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d)); procs.push(p);
  return { port, p, out: () => out, stop: () => new Promise((r) => { p.once("exit", r); p.kill("SIGTERM"); setTimeout(r, 1500); }) };
}
function conn(port, myId, extra, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:" + port, { headers: headers || {} }); const events = [];
    ws.on("error", reject); ws.on("message", (raw) => events.push(JSON.parse(raw)));
    ws.on("open", () => { ws.send(JSON.stringify(Object.assign({ type: "register", id: myId, name: "n" + myId[0], visible: true, publicKey: { kty: "EC", crv: "P-256", x: "x" + myId[0], y: "y" } }, extra || {}))); setTimeout(() => resolve({ ws, events, send: (o) => ws.send(JSON.stringify(o)) }), 200); });
  });
}
async function retry(port, myId, extra, headers) { for (let i = 0; i < 40; i++) { try { return await conn(port, myId, extra, headers); } catch (e) { await wait(100); } } throw new Error("нет сервера"); }
const types = (c, t) => c.events.filter((e) => e.type === t);
const env1 = { iv: "AAAA", ct: "BBBB", v: 1, rc: 1 };
const sub = (n) => ({ endpoint: "https://fcm.googleapis.com/fcm/send/" + n, keys: { p256dh: "B".repeat(40), auth: "A".repeat(16) } });
const claimOf = (t) => crypto.createHash("sha256").update("ether-claim-v1|" + t).digest("hex");
const hex = () => crypto.randomBytes(32).toString("hex");
const pubk = () => crypto.randomBytes(65).toString("base64url");
const post = (port, p, body, headers, raw) => fetch("http://127.0.0.1:" + port + p, { method: "POST", headers: Object.assign(raw ? { "Content-Type": "application/octet-stream" } : { "Content-Type": "application/json" }, headers || {}), body: raw ? body : JSON.stringify(body) });
// Сырой HTTP-запрос: отправляем только заголовки (тело «обещано» Content-Length, но не посылается) и смотрим, ответил ли сервер, не дожидаясь тела.
function rawPut(port, hdrs, extra) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1"); let buf = "";
    s.on("data", (d) => { buf += d; if (/\r\n\r\n/.test(buf)) { resolve({ status: Number(buf.split(" ")[1]), sock: s }); } });
    s.on("error", () => resolve({ status: 0, sock: s }));
    s.write("POST /link/put HTTP/1.1\r\nHost: x\r\n" + Object.entries(hdrs).map(([k, v]) => k + ": " + v + "\r\n").join("") + (extra || "") + "\r\n");
    setTimeout(() => resolve({ status: -1, sock: s }), 1200);
  });
}

(async () => {
  // ---------- S1: '#' в id/to ----------
  console.log("\n=== S1: '#' запрещён в id основного устройства и в адресатах ===");
  {
    const S = start({}); const P = S.port;
    const A = await retry(P, id("a"));
    const bad = await retry(P, "victim#0123456789abcdef");
    check("register с '#' в id → register-error invalid-id", types(bad, "register-error").length === 1 && types(bad, "register-error")[0].error === "invalid-id" && types(bad, "registered").length === 0);
    const n0 = types(A, "deliver-ack").length;
    A.send({ type: "deliver", to: id("b") + "#0123456789abcdef", msgId: "m1", envelope: env1, kind: "chat" }); await wait(150);
    check("deliver на 'id#dev' игнорируется (ящик companion не заполняется, ack не приходит)", types(A, "deliver-ack").length === n0);
    A.send({ type: "deliver", to: id("b"), msgId: "m2", envelope: env1, kind: "chat" }); await wait(150);
    check("deliver на обычный id работает", types(A, "deliver-ack").length === n0 + 1);
    A.send({ type: "devices-get", to: id("b") + "#0123456789abcdef", rid: "r1" }); A.send({ type: "prekey-fetch", to: "x#y", rid: "r2" }); await wait(150);
    check("devices-get / prekey-fetch с '#' игнорируются", types(A, "devices-list").length === 0 && types(A, "prekey-bundle").length === 0);
    A.send({ type: "signal", to: "x#y", data: { t: "offer" } }); await wait(100);
    check("signal на id с '#' не даёт ответа (игнор)", types(A, "unreachable").length === 0);
    A.send({ type: "devices-get", to: id("b"), rid: "r3" }); await wait(100);
    check("devices-get на обычный id отвечает", types(A, "devices-list").length === 1);
    const dev = require("./devices");
    const calls = []; const ctx = { isValidEnvelope: () => true, cleanEnvelope: (e) => e, mailboxPut: (...a) => calls.push(a), scheduleSave() {}, deviceLists: new Map(), clientsGet: () => null, WebSocket: { OPEN: 1 }, safeSend() {} };
    const r1 = dev.dispatch(ctx, { fromId: "a", fromDev: "0123456789abcdef", to: "victim#0123456789abcdef", msgId: "m", kind: "chat", envelope: env1, copies: null, fromPublicKey: null });
    check("devices.dispatch: to с '#' → false, ящик не тронут", r1 === false && calls.length === 0);
    const r2 = dev.dispatch(ctx, { fromId: "a", fromDev: "0123456789abcdef", to: "victim", msgId: "m", kind: "chat", envelope: env1, copies: null, fromPublicKey: null });
    check("devices.dispatch: обычный to работает (companion → основное)", r2 === true && calls.length === 1 && calls[0][0] === "victim");
    check("validPeerId", dev.validPeerId("abc") && !dev.validPeerId("a#b") && !dev.validPeerId("") && !dev.validPeerId("x".repeat(129)) && !dev.validPeerId(5));
    A.ws.close(); bad.ws.close(); await S.stop();
  }

  // ---------- S2: push о звонке ----------
  console.log("\n=== S2: push о звонке — только при подписке получателя и canReach, отдельный лимит на IP ===");
  {
    const S = start({ STRICT_ROSTER: "1", CALL_PUSH_PER_IP_PER_MIN: "2" }); const P = S.port;
    const A = await retry(P, id("a"));
    const inv = (to, x) => A.send({ type: "signal", to, data: { t: "call-invite", x } });
    const allowed = () => (S.out().match(/\[call-push\] allowed/g) || []).length;
    inv(id("n"), "s1"); await wait(150);
    check("получатель без push-подписки: push не планируется и лимит не расходуется", allowed() === 0 && !/throttled/.test(S.out()));
    const H = await retry(P, id("h"), { visible: false }); H.send({ type: "push-subscribe", subscription: sub("h"), lang: "en" }); await wait(120);
    inv(id("h"), "s2"); await wait(150);
    check("скрытый онлайн-получатель (отправителя нет в его ростере): push не уходит", allowed() === 0 && types(A, "unreachable").length >= 1);
    const V = await retry(P, id("v"), { visible: true }); V.send({ type: "push-subscribe", subscription: sub("v"), lang: "en" }); await wait(120);
    V.send({ type: "watch", ids: [id("a")] }); A.send({ type: "watch", ids: [id("v")] }); await wait(120);
    inv(id("v"), "s3"); await wait(150);
    check("достижимый получатель с подпиской: push разрешён", allowed() === 1);
    for (const n of ["o1", "o2", "o3"]) { const R = await retry(P, id(n[1]) .slice(0, 63) + n[1], {}); R.send({ type: "push-subscribe", subscription: sub(n), lang: "en" }); await wait(100); R.ws.close(); }
    await wait(100);
    inv(id("1"), "s4"); inv(id("2"), "s5"); inv(id("3"), "s6"); await wait(250);
    check("отдельный лимит на IP отправителя: сверх CALL_PUSH_PER_IP_PER_MIN push не уходит (allowed=" + allowed() + ")", allowed() === 2 && /ip-throttled/.test(S.out()));
    for (const c of [A, H, V]) c.ws.close(); await S.stop();
  }

  // ---------- S3/S4/S5: devicelink ----------
  console.log("\n=== S3: /link/put проверяет заголовки/размер/параллельность ДО чтения тела ===");
  {
    const S = start({ LINK_MAX_BLOB: "65536", LINK_MAX_PUTS: "2", LINK_INIT_PER_MIN: "100" }); const P = S.port;
    await retry(P, id("z")).then((c) => c.ws.close());
    const mk = async () => { const t = hex(), u = hex(); await post(P, "/link/init", { t, u, pub: pubk() }); await post(P, "/link/join", { t, pub: pubk() }); return { t, u }; };
    let r = await rawPut(P, { "X-Link-T": hex(), "X-Link-U": hex(), "Content-Length": 60000, "Content-Type": "application/octet-stream" });
    check("неверные X-Link-*: 404 сразу, без ожидания тела", r.status === 404); r.sock.destroy();
    const c1 = await mk();
    r = await rawPut(P, { "X-Link-T": c1.t, "X-Link-U": c1.u, "Content-Length": 70000 });
    check("Content-Length больше лимита: 413 сразу, без чтения тела", r.status === 413); r.sock.destroy();
    r = await rawPut(P, { "X-Link-T": c1.t, "X-Link-U": c1.u, "Transfer-Encoding": "chunked" });
    check("без Content-Length (chunked): 411", r.status === 411); r.sock.destroy();
    r = await rawPut(P, { "X-Link-T": c1.t, "X-Link-U": c1.u, "Content-Length": 0 });
    check("пустое тело: 400", r.status === 400); r.sock.destroy();
    // параллельность: два «зависших» put занимают слоты, третий получает 503
    const c2 = await mk(), c3 = await mk();
    const hold = (c) => new Promise((res) => { const s = net.connect(P, "127.0.0.1"); s.write("POST /link/put HTTP/1.1\r\nHost: x\r\nX-Link-T: " + c.t + "\r\nX-Link-U: " + c.u + "\r\nContent-Length: 1000\r\n\r\nabc"); setTimeout(() => res(s), 150); });
    const h1 = await hold(c1), h2 = await hold(c2);
    r = await rawPut(P, { "X-Link-T": c3.t, "X-Link-U": c3.u, "Content-Length": 1000 });
    check("лимит параллельных put: третий → 503", r.status === 503); r.sock.destroy();
    h1.destroy(); await wait(200); // обрыв освобождает слот
    const ok = await post(P, "/link/put", crypto.randomBytes(500), { "X-Link-T": c3.t, "X-Link-U": c3.u }, true);
    check("после обрыва слот освобождён, обычный put проходит: 200", ok.status === 200);
    h2.destroy();
    await S.stop();
  }
  console.log("\n=== S4: квота каналов на IP ===");
  {
    const S = start({ LINK_MAX_PER_IP: "3", LINK_INIT_PER_MIN: "100" }); const P = S.port; await retry(P, id("z")).then((c) => c.ws.close());
    const st = []; for (let i = 0; i < 5; i++) st.push((await post(P, "/link/init", { t: hex(), u: hex(), pub: pubk() })).status);
    check("с одного IP открывается не больше LINK_MAX_PER_IP каналов, дальше 429 (" + st.join(",") + ")", st.slice(0, 3).every((x) => x === 200) && st[3] === 429 && st[4] === 429);
    await S.stop();
  }
  console.log("\n=== S5: глобальный потолок неудач применяется ===");
  {
    const S = start({ LINK_GLOBAL_FAIL_PER_MIN: "5", LINK_INIT_PER_MIN: "100" }); const P = S.port; await retry(P, id("z")).then((c) => c.ws.close());
    const t = hex(), u = hex(); await post(P, "/link/init", { t, u, pub: pubk() });
    const st = []; for (let i = 0; i < 8; i++) st.push((await post(P, "/link/state", { t: hex(), u: hex() })).status);
    check("после потолка неудач ответ 429 (" + st.join(",") + ")", st.slice(0, 5).every((x) => x === 404) && st[7] === 429);
    check("и верный запрос временно получает 429, init остаётся доступен", (await post(P, "/link/state", { t, u })).status === 429 && (await post(P, "/link/init", { t: hex(), u: hex(), pub: pubk() })).status === 200);
    await S.stop();
  }

  // ---------- S6: кэш картинок превью ----------
  console.log("\n=== S6: параллельные запросы одной картинки делят один fetch ===");
  {
    let hits = 0;
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const mock = http.createServer((req, res) => { hits++; setTimeout(() => { res.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length }); res.end(png); }, 150); });
    await new Promise((r) => mock.listen(0, "127.0.0.1", r));
    const pre = path.join(tmp, "pre6.js");
    fs.writeFileSync(pre, `const dns=require("dns");dns.lookup=(h,cb)=>h==="pub.test"?cb(null,"93.184.216.34",4):cb(new Error("ENOTFOUND"));
const http=require("http");const og=http.get;http.get=(u,o,cb)=>og({host:"127.0.0.1",port:+process.env.MOCK_PORT,path:u.pathname+u.search,headers:o.headers,timeout:o.timeout},cb);`);
    const S = start({ MOCK_PORT: String(mock.address().port) }, pre); await retry(S.port, id("z")).then((c) => c.ws.close());
    const get = () => new Promise((resolve) => http.get({ host: "127.0.0.1", port: S.port, path: "/link-preview-image?url=" + encodeURIComponent("http://pub.test/a.png") }, (res) => { const b = []; res.on("data", (d) => b.push(d)); res.on("end", () => resolve({ status: res.statusCode, len: Buffer.concat(b).length })); }));
    const rs = await Promise.all([get(), get(), get(), get()]);
    check("4 параллельных запроса → 1 обращение к источнику, все получили картинку (hits=" + hits + ")", hits === 1 && rs.every((x) => x.status === 200 && x.len === png.length));
    const r2 = await get();
    check("повтор из кэша без нового fetch", r2.status === 200 && hits === 1);
    await S.stop(); mock.close();
  }

  // ---------- S7: TRUST_PROXY ----------
  console.log("\n=== S7: X-Forwarded-For по умолчанию игнорируется ===");
  {
    const open = async (env) => {
      const S = start(Object.assign({ MAX_SOCKETS_PER_IP: "2" }, env)); await retry(S.port, id("z")).then((c) => c.ws.close()); await wait(100);
      const cs = []; for (let i = 0; i < 4; i++) { try { cs.push(await conn(S.port, id("abcd"[i]), {}, { "X-Forwarded-For": "9.9.9." + i })); } catch (e) {} }
      await wait(400); const alive = cs.filter((c) => c.ws.readyState === WebSocket.OPEN).length; cs.forEach((c) => c.ws.close()); await S.stop(); return alive;
    };
    const def = await open({}), on = await open({ TRUST_PROXY: "1" });
    check("по умолчанию подделка XFF не обходит лимит соединений на IP (открыто " + def + " из 4, лимит 2)", def === 2);
    check("TRUST_PROXY=1: IP берётся из XFF — все 4 разных «клиента» проходят (открыто " + on + ")", on === 4);
    const yml = fs.readFileSync(path.join(__dirname, "..", "render.yaml"), "utf8");
    check("render.yaml включает TRUST_PROXY=1 для продакшена", /key:\s*TRUST_PROXY\s*\n\s*value:\s*"?1"?/.test(yml));
    check("SELF_HOSTING.md описывает TRUST_PROXY", /TRUST_PROXY/.test(fs.readFileSync(path.join(__dirname, "SELF_HOSTING.md"), "utf8")));
  }

  // ---------- S8: сохранение ящика ----------
  console.log("\n=== S8: потоковая запись ящика, потолок сохраняет самые новые записи любых видов ===");
  {
    const FILE = path.join(tmp, "mb.json");
    const S = start({ MAILBOX_PERSIST: "1", MAILBOX_FILE: FILE, MAILBOX_PERSIST_MAX_BYTES: "4000" }); const P = S.port;
    const A = await retry(P, id("a"));
    const e = (n) => ({ iv: "AAAA", ct: "C".repeat(n), v: 1, rc: 1 });
    A.send({ type: "deliver", to: id("b"), msgId: "old-sync", envelope: e(900), kind: "sync-op" }); await wait(40);
    A.send({ type: "deliver", to: id("b"), msgId: "mid-chat", envelope: e(900), kind: "chat" }); await wait(40);
    A.send({ type: "deliver", to: id("b"), msgId: "new-sync", envelope: e(900), kind: "sync-op" }); await wait(40);
    A.send({ type: "deliver", to: id("b"), msgId: "new-chat", envelope: e(900), kind: "chat" });
    await wait(2800);
    let data = null; try { data = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (x) {}
    const ids = data ? data.boxes.flatMap(([, es]) => es.map(([m]) => m)) : [];
    check("файл валидный JSON формата v1", !!data && data.v === 1 && Array.isArray(data.boxes));
    check("потолок: самые старые отброшены, не-chat (sync-op) новее лимита сохранены (" + ids.join(",") + ")", ids.includes("new-chat") && ids.includes("new-sync") && !ids.includes("old-sync"));
    check("tmp-файл не остался", !fs.existsSync(FILE + ".tmp"));
    A.ws.close(); await S.stop();
    const S2 = start({ MAILBOX_PERSIST: "1", MAILBOX_FILE: FILE }); const B = await retry(S2.port, id("b"));
    check("после перезапуска записи восстановлены", types(B, "deliver").filter((d) => d.queued).length === ids.length);
    B.ws.close(); await S2.stop();
  }

  // ---------- S9: discovery ----------
  console.log("\n=== S9: чужой активный phone-hash не перезаписывается ===");
  {
    const S = start({}); const P = S.port;
    const A = await retry(P, id("a"), { claim: claimOf("A") }); const B = await retry(P, id("b"), { claim: claimOf("B") });
    const salt = types(A, "registered")[0].discoverySalt; const h = (s) => crypto.createHmac("sha256", salt).update(s).digest("hex");
    const pub = async (c, hashes) => { const n = c.events.length; c.send({ type: "discovery-publish", hashes }); for (let i = 0; i < 30; i++) { await wait(50); const r = c.events.slice(n).find((x) => x.type === "discovery-published"); if (r) return r; } return null; };
    const look = async (c, hashes, rid) => { const n = c.events.length; c.send({ type: "discovery-lookup", rid, hashes }); for (let i = 0; i < 30; i++) { await wait(50); const r = c.events.slice(n).find((x) => x.type === "discovery-result" && x.rid === rid); if (r) return r; } return null; };
    const hv = h("79001112233"), hx = h("79009998877");
    check("A публикует хэш", (await pub(A, [hv])).ok === true);
    const pb = await pub(B, [hv]);
    check("B не может перезаписать активный хэш A: ok=false, conflict", pb.ok === false && pb.error === "conflict");
    const C = await retry(P, id("c"), { claim: claimOf("C") });
    check("lookup по-прежнему возвращает A", (await look(C, [hv], "q1")).found[0].id === id("a"));
    const pb2 = await pub(B, [hv, hx]);
    check("частичный конфликт: свободный хэш публикуется, конфликтный нет", pb2.ok === true && pb2.count === 1 && pb2.conflicts === 1);
    const rr = await look(C, [hv, hx], "q2");
    check("A остался владельцем hv, B владеет hx", rr.found.find((f) => f.hash === hv).id === id("a") && rr.found.find((f) => f.hash === hx).id === id("b"));
    await pub(A, []); // A снимает свою публикацию
    check("после снятия владельцем хэш свободен для B", (await pub(B, [hv])).ok === true);
    for (const c of [A, B, C]) c.ws.close(); await S.stop();
  }

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
