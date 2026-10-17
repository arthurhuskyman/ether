// Покрытие: guards.js и meta-extract.js — граничные значения чистых функций (без запуска сервера)
const assert = require("assert");
const g = require("./guards");
const m = require("./meta-extract");
let pass = 0, fail = 0;
function check(label, fn) { try { fn(); pass++; console.log("  OK   " + label); } catch (e) { fail++; console.log("  FAIL " + label + ": " + e.message); } }

check("isPrivateIp: IPv4 диапазоны", () => {
  for (const ip of ["0.0.0.0", "10.1.2.3", "100.64.0.1", "100.127.255.255", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.1", "192.0.2.5", "192.168.1.1", "198.18.0.1", "198.19.0.1", "198.51.100.7", "203.0.113.9", "224.0.0.1", "255.255.255.255"]) assert.strictEqual(g.isPrivateIp(ip), true, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "100.63.255.255", "100.128.0.1", "172.15.0.1", "172.32.0.1", "192.0.1.1", "198.17.0.1", "198.20.0.1", "203.0.114.1", "223.255.255.255"]) assert.strictEqual(g.isPrivateIp(ip), false, ip);
});
check("isPrivateIp: IPv6 частные/служебные", () => {
  for (const ip of ["::", "::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "::192.168.0.1", "64:ff9b::1", "2002::1", "2001::1", "2001:db8::1", "100::1", "fe80::1", "fe80::1%eth0", "febf::1", "fec0::1", "fc00::1", "fd12:3456::1", "ff02::1"]) assert.strictEqual(g.isPrivateIp(ip), true, ip);
  for (const ip of ["2606:4700:4700::1111", "2a00:1450:4001::200e", "::ffff:8.8.8.8", "2001:4860:4860::8888"]) assert.strictEqual(g.isPrivateIp(ip), false, ip);
});
check("isPrivateIp: мусор считается небезопасным", () => {
  for (const v of ["", null, undefined, "abc", "1.2.3", "1.2.3.4.5", "999.1.1.1", "::g", "1:2:3:4:5:6:7:8:9", "example.com", 5, {}]) assert.strictEqual(g.isPrivateIp(v), true, String(v));
});
check("parseIPv6: формы записи", () => {
  assert.deepStrictEqual(g.parseIPv6("::"), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepStrictEqual(g.parseIPv6("1::"), [1, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepStrictEqual(g.parseIPv6("::1"), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepStrictEqual(g.parseIPv6("1:2:3:4:5:6:7:8"), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepStrictEqual(g.parseIPv6("::ffff:1.2.3.4"), [0, 0, 0, 0, 0, 0xffff, 0x102, 0x304]);
  assert.deepStrictEqual(g.parseIPv6("FE80::1%lo0"), [0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  for (const bad of ["1::2::3", "1:2:3:4:5:6:7:8:9", "1:2:3", "::1.2.3.999", "1:2:3:4:5:6:7::8:9", "xyz::1", "12345::1"]) assert.strictEqual(g.parseIPv6(bad), null, bad);
});
check("pushHostAllowed: точные хосты и суффиксы", () => {
  for (const h of ["fcm.googleapis.com", "FCM.googleapis.com", "android.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com", "x.push.services.mozilla.com", "a.b.push.apple.com", "dm1.notify.windows.com"]) assert.strictEqual(g.pushHostAllowed(h), true, h);
  for (const h of ["", null, undefined, "evil.com", "push.apple.com", ".push.apple.com", "notify.windows.com", "fcm.googleapis.com.evil.com", "googleapis.com"]) assert.strictEqual(g.pushHostAllowed(h), false, String(h));
});
check("validatePushSubscription: валидная нормализуется, лишнее отбрасывается", () => {
  const ok = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "B".repeat(30), auth: "a".repeat(16) }, extra: "x", expirationTime: 123 };
  const r = g.validatePushSubscription(ok);
  assert.deepStrictEqual(r, { endpoint: ok.endpoint, keys: ok.keys, expirationTime: 123 });
  assert.ok(!("extra" in r));
  assert.ok(!("expirationTime" in g.validatePushSubscription({ ...ok, expirationTime: null })));
  assert.ok(!("expirationTime" in g.validatePushSubscription({ ...ok, expirationTime: NaN })));
  assert.ok(g.validatePushSubscription({ ...ok, endpoint: "https://fcm.googleapis.com:443/x" }));
});
check("validatePushSubscription: отказы", () => {
  const good = { endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "B".repeat(30), auth: "a".repeat(16) } };
  const bads = [null, undefined, 5, "s", [], {}, { ...good, endpoint: 5 }, { ...good, endpoint: "https://fcm.googleapis.com/" + "a".repeat(1100) },
    { ...good, endpoint: "http://fcm.googleapis.com/x" }, { ...good, endpoint: "https://u:p@fcm.googleapis.com/x" }, { ...good, endpoint: "https://fcm.googleapis.com:8443/x" },
    { ...good, endpoint: "https://evil.com/x" }, { ...good, endpoint: "not a url" }, { ...good, keys: null }, { ...good, keys: "k" },
    { ...good, keys: { p256dh: "short", auth: good.keys.auth } }, { ...good, keys: { p256dh: "B".repeat(201), auth: good.keys.auth } }, { ...good, keys: { p256dh: "!".repeat(30), auth: good.keys.auth } },
    { ...good, keys: { p256dh: good.keys.p256dh, auth: "a" } }, { ...good, keys: { p256dh: good.keys.p256dh, auth: "a".repeat(65) } }, { ...good, keys: { p256dh: good.keys.p256dh, auth: "bad auth!" } },
    { ...good, big: "x".repeat(5000) }];
  bads.forEach((b, i) => assert.strictEqual(g.validatePushSubscription(b), null, "case " + i));
  const circ = {}; circ.self = circ; assert.strictEqual(g.validatePushSubscription(circ), null);
});
check("validLang", () => {
  for (const l of ["ru", "en", "pt-BR", "zh-Hans", "ceb", "es-419"]) assert.strictEqual(g.validLang(l), true, l);
  for (const l of ["", "r", "toolongcode-xxxxxxxx", "ru_RU", "ru-", "1a", "<script>", null, undefined, 5, "ab-cdefghijk"]) assert.strictEqual(g.validLang(l), false, String(l));
});
check("clientIpFrom: прокси и прямое соединение", () => {
  const req = (xff, addr) => ({ socket: { remoteAddress: addr }, headers: xff === undefined ? {} : { "x-forwarded-for": xff } });
  assert.strictEqual(g.clientIpFrom(req("1.1.1.1, 2.2.2.2", "9.9.9.9"), false), "9.9.9.9");
  assert.strictEqual(g.clientIpFrom(req("1.1.1.1, 2.2.2.2", "9.9.9.9"), true), "2.2.2.2");
  assert.strictEqual(g.clientIpFrom(req(undefined, "9.9.9.9"), true), "9.9.9.9");
  assert.strictEqual(g.clientIpFrom(req(" , ", "9.9.9.9"), true), "9.9.9.9");
  assert.strictEqual(g.clientIpFrom(req("x".repeat(100), "9.9.9.9"), true), "9.9.9.9");
  assert.strictEqual(g.clientIpFrom(null, false), "unknown");
  assert.strictEqual(g.clientIpFrom({}, true), "unknown");
});
check("sanitizeForLog: управляющие символы, усечение, null", () => {
  assert.strictEqual(g.sanitizeForLog("a\nb\r\tc\u0000d e\u007f"), "a b  c d e ");
  assert.strictEqual(g.sanitizeForLog(null), ""); assert.strictEqual(g.sanitizeForLog(undefined), "");
  assert.strictEqual(g.sanitizeForLog("x".repeat(70)), "x".repeat(64) + "…");
  assert.strictEqual(g.sanitizeForLog("x".repeat(10), 5), "xxxxx…");
  assert.strictEqual(g.sanitizeForLog(12345), "12345");
});

check("decodeHtmlEntities: именованные, десятичные, hex, некорректные", () => {
  assert.strictEqual(m.decodeHtmlEntities("&amp;&lt;&gt;&quot;&#39;&apos;"), "&<>\"''");
  assert.strictEqual(m.decodeHtmlEntities("&#8212;&#x2014;&#X2014;"), "———");
  assert.strictEqual(m.decodeHtmlEntities("&#99999999999;"), "&#99999999999;");
  assert.strictEqual(m.decodeHtmlEntities("&#xFFFFFFFFF;"), "&#xFFFFFFFFF;");
});
check("scanHtml: meta в разных кавычках, регистр, первый title, лимиты", () => {
  const r = m.scanHtml(`<HEAD><META PROPERTY="og:title" CONTENT="A &amp; B"><meta name='description' content='D'><meta name=robots content=noindex><meta property="og:title" content="second"><meta charset="utf-8"><metadata x="1"><title> T1 </title><title>T2</title>`);
  assert.strictEqual(r.metas["og:title"], "A & B"); assert.strictEqual(r.metas.description, "D"); assert.strictEqual(r.metas.robots, "noindex");
  assert.strictEqual(r.title, "T1"); assert.ok(!("charset" in r.metas));
  assert.strictEqual(m.scanHtml("<title>unterminated").title, "");
  assert.strictEqual(m.scanHtml("<title>x</title >").title, "");
  assert.strictEqual(m.scanHtml("<titlex>no</titlex><title>yes</title>").title, "yes");
  assert.strictEqual(m.scanHtml("<title>" + "a".repeat(1100) + "</title>").title, "");
  assert.strictEqual(m.scanHtml("<meta ".repeat(5000)).title, "");
  const many = "<meta name='k0' content='v'>".repeat(1) + Array.from({ length: 300 }, (_, i) => `<meta name='k${i + 1}' content='v'>`).join("") + "<title>late</title>";
  const rm = m.scanHtml(many); assert.strictEqual(rm.title, "late"); assert.ok(!("k299" in rm.metas));
  assert.strictEqual(m.scanHtml("<meta name='a' content='" + "x".repeat(3000) + "'>").metas.a, undefined);
  assert.strictEqual(m.scanHtml("<meta name='" + "n".repeat(50) + "' content='v'>").metas["n".repeat(50)], undefined);
  assert.deepStrictEqual(Object.keys(m.scanHtml("<meta name='a'>").metas), []);
  assert.strictEqual(m.scanHtml("<meta name='a' content='b'").metas.a, undefined);
});
check("extractMeta: приоритеты, абсолютизация картинки, фолбэки, null", () => {
  const html = `<meta property="og:title" content="OG"><meta property="og:description" content="OD"><meta property="og:image" content="/i.png"><meta property="og:site_name" content="Site"><title>TT</title>`;
  const r = m.extractMeta(html, "https://www.example.com/a/b");
  assert.deepStrictEqual(r, { url: "https://www.example.com/a/b", title: "OG", description: "OD", image: "https://www.example.com/i.png", siteName: "Site" });
  const r2 = m.extractMeta(`<title>Only</title><meta name="description" content="plain">`, "https://www.example.com/");
  assert.strictEqual(r2.title, "Only"); assert.strictEqual(r2.description, "plain"); assert.strictEqual(r2.siteName, "example.com"); assert.strictEqual(r2.image, "");
  assert.strictEqual(m.extractMeta(`<meta property="og:image" content="javascript:alert(1)">`, "https://e.com/"), null);
  assert.strictEqual(m.extractMeta(`<meta property="og:image" content="http://[bad">`, "https://e.com/"), null);
  assert.ok(m.extractMeta(`<meta property="og:image" content="//cdn.e.com/p.jpg">`, "https://e.com/").image.startsWith("https://cdn.e.com"));
  assert.strictEqual(m.extractMeta("", "https://e.com/"), null); assert.strictEqual(m.extractMeta(null, "https://e.com/"), null);
  const r3 = m.extractMeta(`<title>${"t".repeat(500)}</title>`, "not a url"); assert.strictEqual(r3.title.length, 200); assert.strictEqual(r3.siteName, "");
  const r4 = m.extractMeta(`<meta property="og:description" content="${"d".repeat(400)}">`, "https://e.com/"); assert.strictEqual(r4.description.length, 300);
});

console.log("\n" + pass + " ok, " + fail + " fail");
process.exit(fail ? 1 : 0);
