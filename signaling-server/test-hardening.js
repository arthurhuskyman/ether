// Регрессионные тесты по итогам аудита релея: падение по lang, квоты ящика, SSRF (push и превью), ReDoS, лимиты, подмена IP.
const { spawn } = require("child_process");
const WebSocket = require("ws");
const http = require("http");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { pass++; console.log("  OK   " + label); } else { fail++; console.log("  FAIL " + label); } }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const id = (c) => c.repeat(64);
function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ether-hard-"));
async function startServer(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: Object.assign({}, process.env, { PORT: String(port), MAILBOX_PERSIST: "0", VAPID_PUBLIC: "", VAPID_PRIVATE: "", PUSH_SUBS_FILE: path.join(tmpDir, "subs-" + port + ".json") }, env || {}),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const srv = { port, child, log: "", exited: false };
  child.stdout.on("data", (d) => (srv.log += d));
  child.stderr.on("data", (d) => (srv.log += d));
  child.on("exit", () => (srv.exited = true));
  for (let i = 0; i < 50; i++) {
    const ok = await new Promise((r) => { const s = net.connect(port, "127.0.0.1"); s.on("connect", () => { s.destroy(); r(true); }); s.on("error", () => r(false)); });
    if (ok) return srv;
    await wait(100);
  }
  throw new Error("сервер не поднялся");
}
const stop = async (srv) => { srv.child.kill("SIGTERM"); await wait(300); };
function connect(port, myId, extra, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:" + port, { headers: headers || {} }); const events = [];
    ws.on("error", reject);
    ws.on("message", (raw) => events.push(JSON.parse(raw)));
    ws.on("open", () => {
      if (myId) ws.send(JSON.stringify(Object.assign({ type: "register", id: myId, name: myId.slice(0, 1), visible: true }, extra || {})));
      setTimeout(() => resolve({ ws, events, send: (o) => ws.send(JSON.stringify(o)) }), 200);
    });
  });
}
const validSub = (host) => ({ endpoint: "https://" + (host || "fcm.googleapis.com") + "/fcm/send/abc123", keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) } });
const env1 = { iv: "AAAA", ct: "BBBB", v: 1 };

(async () => {
  // ---------- 8. isPrivateIp: таблица ----------
  console.log("\n=== isPrivateIp: служебные диапазоны ===");
  {
    const { isPrivateIp } = require("./guards");
    const priv = ["0.0.0.0", "0.1.2.3", "10.1.2.3", "100.64.0.1", "100.127.255.255", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255",
      "192.0.0.5", "192.168.1.1", "198.18.0.1", "198.19.255.255", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
      "::", "::1", "fe80::1", "fe8f::1", "fea0::1", "febf::1", "fec0::1", "feff::1", "fc00::1", "fd12:3456::1", "64:ff9b::7f00:1", "64:ff9b::127.0.0.1",
      "2002:7f00:1::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "ff02::1", "not-an-ip"];
    const pub = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "100.63.255.255", "100.128.0.1", "172.15.0.1", "172.32.0.1", "192.0.1.1", "198.17.0.1", "198.20.0.1", "223.255.255.255",
      "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "fe7f::1", "fbff::1"];
    for (const a of priv) check("приватный/служебный: " + a, isPrivateIp(a) === true);
    for (const a of pub) check("публичный: " + a, isPrivateIp(a) === false);
  }

  // ---------- 4. extractMeta: ReDoS ----------
  console.log("\n=== extractMeta: линейный разбор ===");
  {
    const { extractMeta } = require("./meta-extract");
    const big = (s) => s.repeat(Math.ceil(400 * 1024 / s.length));
    for (const [label, html] of [
      ["400 КБ «<meta »", big("<meta ")],
      ["400 КБ «<meta content=\"x\" property=\"og:title\" »", big('<meta content="x" property="og:title" ')],
      ["400 КБ «<meta a=b »", big("<meta a=b ")],
      ["400 КБ «<title »", big("<title ")],
      ["400 КБ пробелов в теге", "<meta " + " ".repeat(400 * 1024) + "content=x"],
    ]) {
      const t0 = Date.now(); extractMeta(html, "https://example.com/"); const dt = Date.now() - t0;
      check(label + " разобрано за " + dt + " мс (<200)", dt < 200);
    }
    const r = extractMeta('<html><head><title> Тест &amp; ок </title><meta content="Описание" name="description"><meta property="og:image" content="/i.png"><meta property="og:site_name" content="Сайт"><metadata content="x" property="og:title"></head>', "https://example.com/a");
    check("title и description (content перед name)", r && r.title === "Тест & ок" && r.description === "Описание");
    check("og:image приводится к абсолютному, site_name читается, <metadata> не принимается за meta", r && r.image === "https://example.com/i.png" && r.siteName === "Сайт");
    const r2 = extractMeta("<meta property='og:title' content='A &#8212; B'><title>zzz</title>", "https://example.com/");
    check("og:title приоритетнее <title>, числовые сущности и одинарные кавычки", r2 && r2.title === "A — B");
    check("пустая страница → null", extractMeta("<html></html>", "https://x.y/") === null || extractMeta("<html></html>", "https://x.y/").title === "");
  }

  // ---------- 5, 17. проверка push-подписки (юнит) ----------
  console.log("\n=== validatePushSubscription / validLang / sanitizeForLog / clientIpFrom ===");
  {
    const g = require("./guards");
    check("FCM-подписка принимается", !!g.validatePushSubscription(validSub()));
    for (const h of ["updates.push.services.mozilla.com", "web.push.apple.com", "x.push.apple.com", "wns2-par02p.notify.windows.com", "android.googleapis.com", "a.push.services.mozilla.com"])
      check("разрешённый хост " + h, !!g.validatePushSubscription(validSub(h)));
    for (const h of ["127.0.0.1", "localhost", "evil.example", "fcm.googleapis.com.evil.example", "169.254.169.254", "notify.windows.com", "evilnotify.windows.com", "[::1]"])
      check("запрещённый хост " + h, g.validatePushSubscription(validSub(h)) === null);
    check("http:// отклонён", g.validatePushSubscription(Object.assign(validSub(), { endpoint: "http://fcm.googleapis.com/x" })) === null);
    check("нестандартный порт отклонён", g.validatePushSubscription(Object.assign(validSub(), { endpoint: "https://fcm.googleapis.com:8443/x" })) === null);
    check("логин в URL отклонён", g.validatePushSubscription(Object.assign(validSub(), { endpoint: "https://u:p@fcm.googleapis.com/x" })) === null);
    check("нет keys отклонено", g.validatePushSubscription({ endpoint: validSub().endpoint }) === null);
    check("auth неверного типа отклонён", g.validatePushSubscription(Object.assign(validSub(), { keys: { p256dh: "B".repeat(87), auth: 5 } })) === null);
    check("слишком большая подписка (>4 КБ) отклонена", g.validatePushSubscription(Object.assign(validSub(), { junk: "x".repeat(5000) })) === null);
    check("лишние поля отбрасываются", !("junk" in (g.validatePushSubscription(Object.assign(validSub(), { junk: "x" })) || { junk: 1 })));
    check("validLang: ru, ru-RU, pt-BR", g.validLang("ru") && g.validLang("ru-RU") && g.validLang("pt-BR"));
    check("validLang отвергает constructor / __proto__ / пустое", !g.validLang("constructor") && !g.validLang("__proto__") && !g.validLang("") && !g.validLang(5));
    check("sanitizeForLog: управляющие символы и обрезка", g.sanitizeForLog("a\nb\r\u0000c" + "x".repeat(200)).indexOf("\n") < 0 && g.sanitizeForLog("x".repeat(200)).length <= 65 && g.sanitizeForLog(undefined) === "");
    const rq = (xff, remote) => ({ headers: xff ? { "x-forwarded-for": xff } : {}, socket: { remoteAddress: remote } });
    check("clientIp: берётся ПОСЛЕДНЯЯ запись X-Forwarded-For", g.clientIpFrom(rq("6.6.6.6, 7.7.7.7, 2.2.2.2", "10.0.0.1"), true) === "2.2.2.2");
    check("clientIp: без заголовка — адрес сокета", g.clientIpFrom(rq("", "10.0.0.1"), true) === "10.0.0.1");
    check("clientIp: TRUST_PROXY=0 игнорирует заголовок", g.clientIpFrom(rq("6.6.6.6", "10.0.0.1"), false) === "10.0.0.1");
  }

  // ---------- 18. LRU rate-limit карт ----------
  console.log("\n=== pruneRateLimitMap: активный ключ не вытесняется потоком мусорных ===");
  {
    const src = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    const a = src.indexOf("const RL_MAX_ENTRIES"), b = src.indexOf("let iceCache");
    const wsFn = src.match(/function wsRateLimitOk\([\s\S]*?\n\}/)[0];
    const lib = new Function(src.slice(a, b) + "\n" + wsFn + "\nreturn { wsRateLimitOk, RL_MAX_ENTRIES };")();
    const map = new Map();
    let hot = 0;
    for (let i = 0; i < 6000; i++) {
      lib.wsRateLimitOk(map, "junk" + i, 1000);
      if (i % 50 === 0) { lib.wsRateLimitOk(map, "hot", 1000); hot++; }
    }
    check("горячий ключ пережил наплыв ключей (счётчик сохранён: " + (map.get("hot") && map.get("hot").n) + "/" + hot + ")", map.get("hot") && map.get("hot").n === hot);
    check("размер карты ограничен", map.size <= lib.RL_MAX_ENTRIES);
  }

  // ---------- 1. lang: constructor ----------
  console.log("\n=== 1. lang='constructor' не роняет процесс ===");
  {
    const src = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    const tbl = src.match(/const PUSH_TEXT = \{[\s\S]*?\n\};/)[0];
    const fn = src.match(/const hasOwn = [^\n]*\nfunction pushText\([\s\S]*?\n\}/)[0];
    const pushText = new Function(tbl + "\n" + fn + "\nreturn pushText;")();
    let threw = false, v;
    try { v = [pushText("constructor", "call"), pushText("__proto__", "incomingCall"), pushText("toString", "newMessage"), pushText("ru", "constructor")]; } catch (e) { threw = true; }
    check("pushText с враждебными lang/key не бросает и возвращает строки", !threw && v.every((x) => typeof x === "string"));
    check("pushText: ru остаётся русским, неизвестный язык — английским", pushText("ru-RU", "call") === "Звонок" && pushText("xx", "call") === "Call");

    const srv = await startServer();
    const A = await connect(srv.port, id("a")), B = await connect(srv.port, id("b"));
    B.send({ type: "push-subscribe", subscription: validSub(), lang: "constructor" });
    B.send({ type: "push-subscribe", subscription: { endpoint: 5, keys: {} }, lang: { toString: 1 } });
    await wait(200);
    A.send({ type: "signal", to: id("b"), data: { t: "call-invite", x: "n1" } });
    A.send({ type: "signal", to: id("b"), data: { t: "call-invite", x: { a: 1 } } });
    A.send({ type: "signal", to: id("b"), data: 5 });
    A.send({ type: "deliver", to: id("b"), msgId: "m1", envelope: { iv: "AA", ct: "BB", h: null, v: 2 } });
    A.send({ type: "watch", ids: "nope" });
    await wait(500);
    A.send({ type: "ping", t: 7 });
    await wait(200);
    check("сервер жив и отвечает после враждебных сообщений", !srv.exited && A.events.some((e) => e.type === "pong" && e.t === 7));
    A.ws.close(); B.ws.close(); await stop(srv);
  }

  // ---------- 2. ящик ----------
  console.log("\n=== 2. квоты ящика ===");
  {
    let srv = await startServer({ MAILBOX_MAX_PER_USER: "5" });
    const A = await connect(srv.port, id("a"));
    for (let i = 0; i < 8; i++) A.send({ type: "deliver", to: id("b"), msgId: "m" + i, envelope: env1, kind: "chat" });
    A.send({ type: "deliver", to: id("b"), msgId: "weird", envelope: { iv: "AAAA", ct: "BBBB", v: 1, evil: "x".repeat(1000), rc: 1 }, kind: "Bad Kind\n!!" });
    A.send({ type: "deliver", to: id("b"), msgId: "longk", envelope: env1, kind: "a".repeat(40) });
    A.send({ type: "deliver", to: id("b"), msgId: "good", envelope: env1, kind: "story" });
    await wait(500);
    const B = await connect(srv.port, id("b"));
    const q = B.events.filter((e) => e.type === "deliver" && e.queued);
    check("в ящике не больше MAILBOX_MAX_PER_USER=5 записей", q.length === 5);
    check("остались последние пять (m7, weird, longk, good + m6)", ["m6", "m7", "weird", "longk", "good"].every((m) => q.some((e) => e.msgId === m)));
    const weird = q.find((e) => e.msgId === "weird"), longk = q.find((e) => e.msgId === "longk"), good = q.find((e) => e.msgId === "good");
    check("неизвестный/мусорный kind → chat; длинный → chat; нормальный сохраняется", weird.kind === "chat" && longk.kind === "chat" && good.kind === "story");
    check("в конверте остаются только известные поля", Object.keys(weird.envelope).sort().join(",") === "ct,iv,rc,v" && !("evil" in weird.envelope));
    A.send({ type: "deliver", to: id("b"), msgId: "badenv", envelope: { iv: "x", ct: "y".repeat(3.6 * 1024 * 1024) } });
    await wait(500);
    check("слишком большой конверт отклонён", A.events.some((e) => e.type === "deliver-ack" && e.msgId === "badenv" && e.error === "invalid-envelope"));
    A.ws.close(); B.ws.close(); await stop(srv);

    srv = await startServer({ MAILBOX_MAX_TOTAL_ENTRIES: "10" });
    const A2 = await connect(srv.port, id("a"));
    for (let i = 0; i < 6; i++) A2.send({ type: "deliver", to: id("b"), msgId: "b" + i, envelope: env1 });
    for (let i = 0; i < 6; i++) A2.send({ type: "deliver", to: id("c"), msgId: "c" + i, envelope: env1 });
    await wait(500);
    const Bq = await connect(srv.port, id("b")), Cq = await connect(srv.port, id("c"));
    const nb = Bq.events.filter((e) => e.type === "deliver" && e.queued).length, nc = Cq.events.filter((e) => e.type === "deliver" && e.queued).length;
    check("общий потолок записей: всего ≤ 10, вытеснены самые старые (b: " + nb + ", c: " + nc + ")", nb + nc <= 10 && nc === 6 && nb < 6);
    for (const c of [A2, Bq, Cq]) c.ws.close();
    await stop(srv);

    srv = await startServer({ MAILBOX_MAX_TOTAL_BYTES: "5000" });
    const A3 = await connect(srv.port, id("a"));
    for (let i = 0; i < 6; i++) A3.send({ type: "deliver", to: id("b"), msgId: "z" + i, envelope: { iv: "AA", ct: "q".repeat(1000) } });
    await wait(500);
    const B3 = await connect(srv.port, id("b"));
    const got = B3.events.filter((e) => e.type === "deliver" && e.queued).map((e) => e.msgId);
    check("общий потолок байт: осталось ≤3 новейших (" + got.join(",") + ")", got.length >= 1 && got.length <= 3 && got.includes("z5"));
    A3.ws.close(); B3.ws.close(); await stop(srv);
  }

  // ---------- 5, 17. push-subscribe через ws + файл подписок ----------
  console.log("\n=== 5, 17. push-subscribe: проверка endpoint, атомарный файл, лимит подписок ===");
  {
    const subsFile = path.join(tmpDir, "subs-main.json");
    const srv = await startServer({ PUSH_SUBS_FILE: subsFile, MAX_PUSH_SUBS: "1" });
    const A = await connect(srv.port, id("a")), B = await connect(srv.port, id("b"));
    A.send({ type: "push-subscribe", subscription: { endpoint: "http://127.0.0.1:1/x", keys: validSub().keys }, lang: "ru" });
    A.send({ type: "push-subscribe", subscription: { endpoint: "https://169.254.169.254/latest", keys: validSub().keys }, lang: "ru" });
    A.send({ type: "push-subscribe", subscription: Object.assign(validSub(), { junk: "x".repeat(5000) }), lang: "ru" });
    await wait(300);
    check("SSRF-endpoint'ы отклонены, подтверждения нет", A.events.filter((e) => e.type === "push-subscribe-error").length === 3 && !A.events.some((e) => e.type === "push-subscribed"));
    A.send({ type: "push-subscribe", subscription: validSub(), lang: "ru_RU" });
    await wait(300);
    check("корректная подписка принята", A.events.some((e) => e.type === "push-subscribed"));
    B.send({ type: "push-subscribe", subscription: validSub("updates.push.services.mozilla.com"), lang: "en" });
    await wait(300);
    check("лимит числа подписок (MAX_PUSH_SUBS=1) соблюдается", B.events.some((e) => e.type === "push-subscribe-error" && e.error === "full"));
    await wait(2500);
    let st = null; try { st = fs.statSync(subsFile); } catch (e) {}
    check("файл подписок записан с правами 0600", !!st && (st.mode & 0o777) === 0o600);
    check("временный файл не остался", !fs.existsSync(subsFile + ".tmp"));
    let parsed = null; try { parsed = JSON.parse(fs.readFileSync(subsFile, "utf8")); } catch (e) {}
    check("файл — валидный JSON с одной подпиской и нормализованным lang", Array.isArray(parsed) && parsed.length === 1 && parsed[0][1].lang === "ru-RU");
    const src = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    check("sendNotification вызывается с timeout", /sendNotification\([\s\S]{0,400}timeout:/.test(src));
    A.ws.close(); B.ws.close(); await stop(srv);
  }

  // ---------- 6. IP клиента ----------
  console.log("\n=== 6. подмена X-Forwarded-For не обходит лимит регистраций ===");
  {
    const srv = await startServer();
    const cs = [];
    for (let i = 0; i < 17; i++) cs.push(await connect(srv.port, "spoof" + i + "x".repeat(40), {}, { "X-Forwarded-For": "1.2.3." + i + ", 9.9.9.9" }));
    const limited = cs.filter((c) => c.events.some((e) => e.type === "register-rate-limited")).length;
    check("регистрации с одного реального IP (последняя запись XFF) упираются в лимит несмотря на разные первые записи (" + limited + ")", limited >= 1);
    const other = await connect(srv.port, "other" + "y".repeat(40), {}, { "X-Forwarded-For": "5.5.5.5, 8.8.8.8" });
    check("другой реальный IP не затронут", other.events.some((e) => e.type === "registered"));
    cs.concat([other]).forEach((c) => c.ws.close()); await stop(srv);
  }

  // ---------- 9, 19. повторный register, вытесненный сокет ----------
  console.log("\n=== 9, 19. повторный register на том же сокете; вытесненный сокет ===");
  {
    const srv = await startServer();
    const W = await connect(srv.port, id("w"));
    const S = await connect(srv.port, id("a"));
    S.send({ type: "register", id: id("b"), name: "b", visible: true });
    await wait(300);
    check("после register B прежняя запись A снята, наблюдатели видят A офлайн", W.events.some((e) => e.type === "presence" && e.id === id("a") && e.online === false));
    W.send({ type: "signal", to: id("a"), data: { t: "x" } });
    W.send({ type: "signal", to: id("b"), data: { t: "x" } });
    await wait(300);
    check("A недостижим (unreachable), B достижим", W.events.some((e) => e.type === "unreachable" && e.to === id("a")) && S.events.some((e) => e.type === "signal" && e.from === id("w")) && !W.events.some((e) => e.type === "unreachable" && e.to === id("b")));

    // вытеснение: старое соединение id c получает replaced, и его сообщения игнорируются
    const old = await connect(srv.port, id("c"));
    const R = await connect(srv.port, id("d"));
    old.ws.on("message", (raw) => { const m = JSON.parse(raw); if (m.type === "replaced") { try { old.send({ type: "deliver", to: id("d"), msgId: "ghost", envelope: env1 }); } catch (e) {} } });
    const fresh = await connect(srv.port, id("c"));
    await wait(500);
    check("старому сокету пришло replaced", old.events.some((e) => e.type === "replaced"));
    check("сообщения вытесненного сокета не обрабатываются (нет ack/доставки)", !old.events.some((e) => e.type === "deliver-ack") && !R.events.some((e) => e.type === "deliver" && e.msgId === "ghost"));
    check("новое соединение id остаётся рабочим", (fresh.send({ type: "signal", to: id("d"), data: { t: "ok" } }), true));
    await wait(300);
    check("сигнал от нового соединения доставлен", R.events.some((e) => e.type === "signal" && e.from === id("c")));
    for (const c of [W, S, old, R, fresh]) { try { c.ws.close(); } catch (e) {} }
    await stop(srv);
  }

  // ---------- 10. publicKey ----------
  console.log("\n=== 10. publicKey при регистрации ===");
  {
    const srv = await startServer();
    const W = await connect(srv.port, id("w"));
    const jwk = { kty: "EC", crv: "P-256", x: "a".repeat(43), y: "b".repeat(43) };
    const g = await connect(srv.port, id("g"), { publicKey: jwk });
    const h1 = await connect(srv.port, id("h"), { publicKey: "x".repeat(5000) });
    const h2 = await connect(srv.port, id("i"), { publicKey: { kty: "EC", big: "x".repeat(2000) } });
    const h3 = await connect(srv.port, id("j"), { publicKey: [1, 2, 3] });
    const pk = (c) => { const e = W.events.find((x) => x.type === "presence" && x.id === id(c) && x.online); return e && e.publicKey; };
    check("нормальный JWK передаётся", JSON.stringify(pk("g")) === JSON.stringify(jwk));
    check("строка 5 КБ → null, большой объект → null, массив → null", pk("h") === null && pk("i") === null && pk("j") === null);
    for (const c of [W, g, h1, h2, h3]) c.ws.close();
    await stop(srv);
  }

  // ---------- 12, 13. prekey-fetch ----------
  console.log("\n=== 12/13. prekey-fetch: лимит на цель и отдельный счётчик ===");
  {
    const srv = await startServer();
    const pub = (c) => [c.repeat(43), c.toUpperCase().repeat(43)];
    const B = await connect(srv.port, id("b"));
    B.send({ type: "prekey-upload", spk: { id: "spk1", pub: pub("s") }, opks: Array.from({ length: 30 }, (_, i) => ({ id: "o" + i, pub: pub("k") })) });
    await wait(200);
    const senders = [];
    for (const c of ["1", "2", "3"]) senders.push(await connect(srv.port, id(c)));
    let n = 0;
    for (const s of senders) for (let i = 0; i < 4; i++) { s.send({ type: "prekey-fetch", to: id("b"), rid: "r" + n++ }); await wait(40); }
    await wait(300);
    const bundles = senders.flatMap((s) => s.events.filter((e) => e.type === "prekey-bundle"));
    const withOpk = bundles.filter((b) => b.opk).length, noOpk = bundles.filter((b) => !b.opk && b.spk && !b.error).length;
    check("12 запросов с трёх аккаунтов: одноразовых выдано ровно 10, остальные получили только spk (" + withOpk + "/" + noOpk + ")", bundles.length === 12 && withOpk === 10 && noOpk === 2);

    const A = senders[0];
    const srv2b = await connect(srv.port, id("e"));
    for (let i = 0; i < 20; i++) srv2b.send({ type: "deliver", to: id("f"), msgId: "d" + i, envelope: env1 });
    await wait(400);
    const before = srv2b.events.length;
    srv2b.send({ type: "prekey-fetch", to: id("f"), rid: "pf" });
    await wait(300);
    const pf = srv2b.events.slice(before).find((e) => e.type === "prekey-bundle" && e.rid === "pf");
    check("prekey-fetch не делит счётчик с deliver (после 20 deliver запрос не получает rate)", pf && !pf.error);
    // обратное направление
    for (let i = 0; i < 13; i++) { srv2b.send({ type: "prekey-fetch", to: id("g"), rid: "q" + i }); await wait(20); }
    srv2b.send({ type: "deliver", to: id("g"), msgId: "after-fetch", envelope: env1 });
    await wait(400);
    check("исчерпанный лимит prekey-fetch не блокирует deliver той же пары", srv2b.events.some((e) => e.type === "deliver-ack" && e.msgId === "after-fetch" && !e.error));
    void A;
    for (const c of senders.concat([B, srv2b])) c.ws.close();
    await stop(srv);
  }

  // ---------- 14. троттлинг push о звонках ----------
  console.log("\n=== 14. троттлинг принудительных push о звонках ===");
  {
    const srv = await startServer();
    const A = await connect(srv.port, id("a")), C = await connect(srv.port, id("c")), D = await connect(srv.port, id("d"));
    const inv = (c, to, x) => c.send({ type: "signal", to, data: { t: "call-invite", x } });
    inv(A, id("b"), "n1"); await wait(150);
    inv(A, id("b"), "n2"); await wait(150);
    inv(C, id("b"), "n3"); await wait(150);
    inv(D, id("e"), "n4"); await wait(250);
    const allowed = (srv.log.match(/\[call-push\] allowed/g) || []).length, thr = (srv.log.match(/\[call-push\] throttled/g) || []).length;
    check("первый call-push пропущен сразу, повтор той же пары — нет, другой отправитель тому же получателю (в пределах пачки из 3) и другой получатель — да (allowed=" + allowed + ", throttled=" + thr + ")", allowed === 3 && thr === 1);
    for (const c of [A, C, D]) c.ws.close();
    await stop(srv);
  }

  // ---------- 16. логи ----------
  console.log("\n=== 16. в логах нет управляющих символов из пользовательских данных ===");
  {
    const srv = await startServer();
    const A = await connect(srv.port, id("a"));
    A.send({ type: "signal", to: id("zz"), data: { t: "evil\nFORGED LOG LINE\u001b[31m" + "q".repeat(500) } });
    A.send({ type: "deliver", to: id("b"), msgId: "id\nFORGED2", envelope: env1, kind: "k\nFORGED3" });
    await wait(400);
    check("поддельные строки не попали в лог отдельной строкой", !/^FORGED/m.test(srv.log) && srv.log.indexOf("\u001b") < 0);
    check("длинное значение обрезано", srv.log.indexOf("q".repeat(100)) < 0);
    A.ws.close(); await stop(srv);
  }

  // ---------- 20. неавторизованные сокеты и лимит соединений ----------
  console.log("\n=== 20. сокеты без register и лимит соединений с IP ===");
  {
    const srv = await startServer({ REGISTER_DEADLINE_MS: "1000", MAX_SOCKETS_PER_IP: "4" });
    const idle = await connect(srv.port, null);
    let idleClosed = false; idle.ws.on("close", () => (idleClosed = true));
    const reg = await connect(srv.port, id("a"));
    let regClosed = false; reg.ws.on("close", () => (regClosed = true));
    await wait(2200);
    check("незарегистрированный сокет закрыт по таймауту", idleClosed);
    check("зарегистрированный остаётся открытым", !regClosed);
    const keep = [];
    for (let i = 0; i < 2; i++) keep.push(await connect(srv.port, id("k" + i)));
    // idle закрыт, reg + 2 = 3 открытых; 4-й допустим, 5-й нет
    const fourth = await connect(srv.port, id("m"));
    const fifth = new WebSocket("ws://127.0.0.1:" + srv.port); let fifthClosed = false; fifth.on("close", () => (fifthClosed = true)); fifth.on("error", () => {});
    await wait(800);
    check("сверх лимита соединений с одного IP — закрывается", fifthClosed);
    check("в пределах лимита — работают", fourth.events.some((e) => e.type === "registered") && keep.every((c) => c.ws.readyState === WebSocket.OPEN));
    for (const c of [reg, fourth].concat(keep)) c.ws.close();
    await stop(srv);
  }

  // ---------- 7. link-preview: зависание ----------
  console.log("\n=== 7. link-preview: зависший и «капающий» сервер не вешают запрос ===");
  {
    const dns = require("dns");
    const realLookup = dns.lookup;
    dns.lookup = function (host, opts, cb) { if (typeof opts === "function") cb = opts; if (/\.preview\.test$/.test(host)) return cb(null, "93.184.216.34", 4); return realLookup.apply(dns, arguments); };
    const realGet = http.get;
    http.get = (u, opts, cb) => realGet(u, Object.assign({}, opts, { lookup: (h, o, c2) => (o && o.all ? c2(null, [{ address: "127.0.0.1", family: 4 }]) : c2(null, "127.0.0.1", 4)) }), cb);
    const hang = http.createServer(() => { /* принимаем и молчим */ });
    const drip = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); const t = setInterval(() => res.write("<p>x</p>"), 500); res.on("close", () => clearInterval(t)); });
    await new Promise((r) => hang.listen(0, r)); await new Promise((r) => drip.listen(0, r));
    const relayPort = await freePort();
    process.env.PORT = String(relayPort); process.env.MAILBOX_PERSIST = "0"; process.env.VAPID_PUBLIC = ""; process.env.VAPID_PRIVATE = ""; process.env.PUSH_SUBS_FILE = path.join(tmpDir, "inproc.json");
    process.env.TRUST_PROXY = "0";
    require("./server.js");
    await wait(500);
    const get = (u) => new Promise((resolve) => {
      const t0 = Date.now();
      const req = http.request({ host: "127.0.0.1", port: relayPort, path: "/link-preview?url=" + encodeURIComponent(u), timeout: 12000 }, (res) => { res.resume(); res.on("end", () => resolve({ status: res.statusCode, ms: Date.now() - t0 })); });
      req.on("timeout", () => { req.destroy(); resolve({ status: "client-timeout", ms: Date.now() - t0 }); }); req.on("error", () => resolve({ status: "error", ms: Date.now() - t0 }));
      req.end();
    });
    const [r1, r2] = await Promise.all([
      get("http://hang.preview.test:" + hang.address().port + "/"),
      get("http://drip.preview.test:" + drip.address().port + "/"),
    ]);
    check("молчащий сервер: ответ 204 за разумное время (" + r1.status + ", " + r1.ms + " мс)", r1.status === 204 && r1.ms < 10000);
    check("медленно «капающий» сервер: общий дедлайн, 204 (" + r2.status + ", " + r2.ms + " мс)", r2.status === 204 && r2.ms < 10500);
    hang.close(); drip.close();
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log("\n" + pass + " ok, " + fail + " fail");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
