// V.88.1: сервер на бесплатном хостинге просыпается — сначала будим его, «нет серверов» только если не ответил;
// метка в шапке короткая; чипы фильтров не обрезаются.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const { closeAll } = require("./harness");
const { boot, sleep } = require("./cov-helpers");
test.after(closeAll);

test("сервер ответил на /health — «просыпается», без «нет серверов», переподключение", async () => {
  const a = await boot();
  a.run(`window.__f = []; window.fetch = async (u) => { window.__f.push(u); return { ok: true }; }; window.__c = 0; signaling = { connected: false, connect: () => { window.__c++; } }; state._serversDown = false;`);
  const ok = await a.run(`srvWakeOrDown("wss://relay.example.org")`);
  assert.equal(ok, true);
  assert.deepEqual(JSON.parse(a.run(`JSON.stringify(window.__f)`)), ["https://relay.example.org/health"]);
  assert.equal(a.run(`state._serversDown`), false);
  assert.equal(a.run(`window.__c`), 1, "после пробуждения — новое подключение");
  a.close();
});

test("сервер не ответил — «нет связи» в шапке, полный текст в подсказке", async () => {
  const a = await boot();
  a.run(`window.fetch = async () => { throw new Error("x"); };`);
  assert.equal(await a.run(`srvWakeOrDown("wss://relay.example.org")`), false);
  const nav = a.document.getElementById("nav-conn-indicator");
  assert.equal(a.run(`state._serversDown`), true);
  assert.equal(nav.textContent, a.run(`T("status.noServerShort")`));
  assert.equal(nav.title, a.run(`T("servers.allDown")`));
  a.close();
});

test("чипы фильтров не сжимаются с многоточием", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "css", "styles.css"), "utf8");
  const m = /\.chat-filter-chip \{([^}]*)\}/.exec(css);
  assert.match(m[1], /flex: 0 0 auto/);
  const ind = /\.nav-conn-indicator \{([^}]*)\}/.exec(css);
  assert.match(ind[1], /max-width: 55%/);
});
