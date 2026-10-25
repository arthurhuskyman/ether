// V.80 fuzz: входящие расшифрованные payload'ы (applyIncomingPayload, handleFilePayload), парсер приглашения в группу, ссылки.
// Контракт: произвольный мусор от недоверенного пира не бросает необработанных исключений, не зависает, не загрязняет прототипы,
// не ломает хранилище контактов (JSON-сериализация и структура сообщений остаются валидными).
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closeAll } = require("./harness");
const { rng, junkValue, junkString } = require("./fuzz-helpers");
test.after(closeAll);

const KINDS = ["chat", "file-meta", "file-chunk", "file-done", "file", "image", "audio", "video", "poll", "poll-vote", "poll-close", "board", "board-op", "note", "note-op", "reaction", "edit", "delete",
  "typing", "ack", "ack-batch", "heartbeat", "online", "contact-card", "sticker", "story", "disappearing-timer", "group-invite", "group-join-request", "group-settings", "privacy-pref", "rc-reset", "id-migrate",
  "sync-op", "sync-sent", "relay-request", "relay-response", "relay-deliver", "relay-deliver-response", "unknown-kind", "__proto__", "constructor"];
const FIELDS = ["id", "text", "name", "size", "mime", "ts", "kind", "groupId", "replyTo", "ttl", "fileId", "idx", "total", "data", "ids", "emoji", "msgId", "members", "options", "votes", "senderName", "seq", "duration", "w", "h", "thumb", "from", "to"];

function mkPayload(r, kind) {
  const p = r.int(8) === 0 ? junkValue(r, 0) : { kind };
  if (p && typeof p === "object" && !Array.isArray(p)) {
    const n = r.int(8);
    for (let i = 0; i < n; i++) p[r.bool() ? FIELDS[r.int(FIELDS.length)] : junkString(r, 1 + r.int(6))] = junkValue(r, 1);
    if (r.int(10) === 0) p.kind = junkValue(r, 2);
  }
  return p;
}
function setup() {
  const a = createApp();
  a.run(`Store.myId = "me"; Store.name = "Me";
    ensureContactEntry("alice", "Alice"); ensureContactEntry("bob", "Bob");
    state.contacts.set("g1", {id:"g1", name:"Team", managed:true, isGroup:true, createdBy:"alice",
      members:[{id:"alice", name:"Alice", role:"admin"}, {id:"me", name:"Me"}, {id:"bob", name:"Bob"}], messages:[], lastActivity:1});
    globalThis.__feed = function (from, id, json) { applyIncomingPayload(from, id, JSON.parse(json)); };
    globalThis.__feedFile = function (from, json) { handleFilePayload(from, JSON.parse(json)); };`);
  return a;
}
function checkInvariants(a, where) {
  assert.equal(a.run(`({}).polluted`), undefined, "загрязнён Object.prototype: " + where);
  assert.equal(a.run(`[].polluted`), undefined, where);
  assert.ok(a.run(`(() => { try { for (const c of state.contacts.values()) { if (!c || typeof c !== "object" || !Array.isArray(c.messages)) return false; for (const m of c.messages) if (!m || typeof m !== "object") return false; } JSON.stringify(Array.from(state.contacts.values())); return true; } catch (e) { return false; } })()`), "контакты повреждены: " + where);
}

test("fuzz: applyIncomingPayload на мусорных payload всех видов — без исключений, без порчи состояния", async () => {
  const r = rng(80020), a = setup();
  const feed = a.run("__feed"), thrown = [];
  const t0 = Date.now();
  for (let i = 0; i < 1500; i++) {
    const kind = KINDS[r.int(KINDS.length)], from = r.pick(["alice", "bob", "stranger", "me", "g1", "__proto__", "constructor"]);
    const payload = mkPayload(r, kind);
    let json; try { json = JSON.stringify(payload); } catch (e) { continue; }
    if (json === undefined) continue;
    try { feed(from, r.bool() ? "m" + i : junkString(r, 5), json); } catch (e) { thrown.push(kind + " from " + from + ": " + String(e && e.message).slice(0, 100) + " <- " + json.slice(0, 120)); }
    if (i % 250 === 249) checkInvariants(a, "iteration " + i);
  }
  checkInvariants(a, "final");
  assert.ok(Date.now() - t0 < 60000, "слишком долго");
  assert.deepEqual(thrown.slice(0, 10), [], `${thrown.length} необработанных исключений из ${1500}`);
  a.close();
});

test("fuzz: handleFilePayload (file-meta / file-chunk / file-done) на мусоре — без исключений и без разрастания буферов", async () => {
  const r = rng(80021), a = setup();
  const feed = a.run("__feedFile"), thrown = [];
  const base = () => ({ kind: ["file-meta", "file-chunk", "file-done"][r.int(3)], id: r.bool() ? "f" + r.int(5) : junkValue(r, 2), name: junkValue(r, 2), size: junkValue(r, 2), mime: junkValue(r, 2), total: junkValue(r, 2), idx: junkValue(r, 2), data: junkValue(r, 2), ts: junkValue(r, 2) });
  for (let i = 0; i < 1200; i++) {
    const p = base();
    for (const k of Object.keys(p)) if (r.int(4) === 0) delete p[k];
    let json; try { json = JSON.stringify(p); } catch (e) { continue; }
    try { feed(r.pick(["alice", "bob", "stranger"]), json); } catch (e) { thrown.push(String(e && e.message).slice(0, 100) + " <- " + json.slice(0, 160)); }
  }
  checkInvariants(a, "file");
  const buffered = a.run(`typeof incomingFileBuffers !== "undefined" ? incomingFileBuffers.size : 0`);
  assert.ok(buffered < 500, "буферы приёма раздуты: " + buffered);
  assert.deepEqual(thrown.slice(0, 10), [], `${thrown.length} исключений`);
  a.close();
});

test("fuzz: parseGroupInviteCode и ссылки #call=/#answer=/#c= на мусоре возвращают null/объект, не бросают", () => {
  const r = rng(80022), a = createApp();
  const pg = a.run("parseGroupInviteCode");
  const pool = ["ether://group?", "gid=", "&ref=", "&rn=", "&gn=", "%", "%E0%A4%A", "x".repeat(4000), "&&&", "=", "🙂", "\u0000", "__proto__", "gid=a&ref=b"];
  for (let i = 0; i < 600; i++) {
    let s = r.bool() ? "ether://group?" : ""; const n = r.int(8); for (let k = 0; k < n; k++) s += r.bool() ? pool[r.int(pool.length)] : junkString(r, r.int(10));
    const v = pg(s); assert.ok(v === null || (typeof v === "object" && typeof v.groupId === "string" && typeof v.refId === "string"), s.slice(0, 50));
  }
  for (const v of [null, undefined, 0, {}, [], "ether://group?gid=a"]) assert.doesNotThrow(() => pg(v));
  checkInvariants(a, "invite");
  a.close();
});
