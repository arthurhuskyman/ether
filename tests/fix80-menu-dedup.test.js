// V.80: аудит дублей в меню и экранах. Одно и то же действие не должно быть дважды в одном меню/на одном экране,
// строки, которые добавляют features*.js / groupadmin, не размножаются при повторных отрисовках.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, closeAll } = require("./harness");
test.after(closeAll);
async function booted(mode) {
  const a = createApp({ storage: { "ether.name": "T", "ether.myId": "me-test-id", "ether.lang": "en", "ether.uiMode": mode || "full" } });
  await a.ready;
  for (let i = 0; i < 60 && !a.run(`typeof __appStarted !== "undefined" && __appStarted`); i++) await new Promise((r) => setTimeout(r, 50));
  a.run(`const c = ensureContactEntry("alice", "Alice"); c.managed = true; c.messages.push({ id: "m1", from: "me", text: "hi", ts: Date.now() }); ensureContactEntry("bob", "Bob"); state.chatId = "alice"; state.tab = "chats"; renderTab();`);
  return a;
}
const norm = (s) => s.replace(/\s+/g, " ").trim();
const dups = (list) => list.filter((x, i) => list.indexOf(x) !== i);
const labels = (root, sel) => Array.from(root.querySelectorAll(sel)).map((b) => norm(b.textContent));

test("меню шапки чата, строки чата, сообщения: подписи и действия не повторяются (full и simple)", async () => {
  for (const mode of ["full", "simple"]) {
    const a = await booted(mode), d = a.document;
    a.run(`openChatHeaderMenu()`);
    const hdr = labels(d, "#anchored-menu .amenu-item");
    assert.deepEqual(dups(hdr), [], mode + " шапка: " + hdr.join("|"));
    for (const gone of ["Search in chat", "Pinned message", "Export chat"]) assert.ok(!hdr.includes(gone), gone + " — дубль значка/баннера/карточки, убран");
    a.run(`closeAnchoredMenu(); openChatRowMenu(state.contacts.get("alice"))`);
    assert.deepEqual(dups(labels(d, "#anchored-menu .amenu-item")), []);
    a.run(`closeAnchoredMenu(); openMessageSheet("m1", "alice")`);
    const acts = Array.from(d.querySelectorAll("#message-sheet-body [data-action]")).map((b) => b.dataset.action);
    assert.deepEqual(dups(acts), []);
    assert.deepEqual(dups(labels(d, "#message-sheet-body .sheet-action")), []);
    a.close();
  }
});

test("меню «+»: нет «Сводки» (она в «⋯» и карточке), id и подписи уникальны", async () => {
  const a = await booted(), d = a.document;
  const items = d.querySelectorAll("#composer-menu-sheet .composer-menu-item");
  assert.deepEqual(dups(Array.from(items).map((b) => b.id)), []);
  assert.deepEqual(dups(labels(d, "#composer-menu-sheet .composer-menu-item")), []);
  assert.equal(d.querySelector("#chat-summary-btn"), null);
  a.run(`openChatHeaderMenu()`);
  assert.ok(labels(d, "#anchored-menu .amenu-item").includes("Chat summary"), "сводка достижима из «⋯»");
  assert.ok(d.querySelector("#contact-summary-btn"), "и из карточки");
  a.close();
});

test("DOM: id уникальны; строки настроек не повторяются в категории; debug и «Контакты» без дублей", async () => {
  const a = await booted(), d = a.document;
  const ids = Array.from(d.querySelectorAll("[id]")).map((e) => e.id);
  assert.deepEqual(dups(ids), []);
  for (const cat of ["profile", "privacy", "notifications", "appearance", "data", "help"]) {
    const rows = [];
    d.querySelectorAll(`[data-settings-category="${cat}"] .settings-row`).forEach((r) => { const t = norm(r.querySelector(":scope > span, :scope > label span") ? (r.querySelector("span") || r).textContent : r.textContent); if (t && r.querySelector("input,select,button") || r.matches("button")) rows.push(t); });
    assert.deepEqual(dups(rows), [], cat + ": " + dups(rows).join("|"));
  }
  // экспорт/импорт и «стереть всё» живут только в настройках
  for (const id of ["export-backup-btn", "import-backup-btn", "debug-hard-reset-btn", "contacts-empty-scan", "contacts-empty-invite"]) assert.equal(d.getElementById(id), null, id + " убран как дубль");
  for (const id of ["settings-export-backup-btn", "settings-import-backup-btn", "settings-delete-account-btn", "scan-qr-btn", "add-contact-btn"]) assert.ok(d.getElementById(id), id + " остался");
  // старое поле «Сервер» скрыто, пока в нём нет адреса; «Серверы» — единственный вход
  assert.ok(d.getElementById("settings-legacy-server").classList.contains("hidden"));
  assert.ok(d.getElementById("servers-open-btn"));
  a.close();
});

test("повторные отрисовки не размножают вставленные строки (настройки, карточка, группа, сообщение)", async () => {
  const a = await booted(), d = a.document;
  const gid = a.run(`(function(){ const g = createGroup("Team", ["alice","bob"]); return g && (g.id || g); })()`);
  const count = () => ({
    settings: d.querySelectorAll("#screen-settings button, #screen-settings input, #screen-settings select").length,
    card: d.querySelectorAll("#screen-contact button, #screen-contact select, #screen-contact input").length,
    group: d.querySelectorAll("#group-info-sheet button, #group-info-sheet input, #group-info-sheet select").length,
    panels: d.querySelectorAll("#group-admin-panel").length,
    fx: d.querySelectorAll("#fx-settings-group, #fx2-settings-group, #fx-presets-group").length,
  });
  const once = () => { a.run(`openContactCard("alice"); openGroupInfo(${JSON.stringify(gid)}); openMessageSheet("m1", "alice");`); return count(); };
  const first = once();
  for (let i = 0; i < 3; i++) { for (const t of ["settings", "connect", "debug", "chats"]) a.run(`state.tab = ${JSON.stringify(t)}; renderTab()`); }
  for (const c of ["profile", "privacy", "notifications", "appearance", "data", "help"]) a.run(`openSettingsCategory(${JSON.stringify(c)}); renderSettingsCategories()`);
  a.run(`applyStaticTranslations()`);
  const again = once(); once();
  assert.deepEqual(again, first);
  assert.equal(first.panels <= 1, true);
  assert.equal(first.fx, 3);
  a.close();
});

test("группа: у участника одно действие «удалить» (✕ скрыт, когда есть «Удалить» с причиной)", async () => {
  const a = await booted(), d = a.document;
  const gid = a.run(`(function(){ const g = createGroup("Team", ["alice","bob"]); return g && (g.id || g); })()`);
  a.run(`openGroupInfo(${JSON.stringify(gid)})`);
  const kick = a.run(`T("group.kick")`), rm = a.run(`T("group.remove")`);
  const advKicks = Array.from(d.querySelectorAll("#group-admin-panel button")).filter((b) => b.textContent === kick).length;
  const xBtns = Array.from(d.querySelectorAll("#group-info-members button")).filter((b) => b.getAttribute("aria-label") === rm).length;
  assert.equal(advKicks, 2);
  assert.equal(xBtns, 0, "дублирующих ✕ нет");
  a.close();
});
