"use strict";
// V.80: локальный полнотекстовый поиск (js/search.js, MsgSearch) в общем поиске и палитре команд. Индекс живёт только в памяти: строится при запуске
// из уже расшифрованного кэша чатов порциями (без блокировки интерфейса) и никогда не сохраняется. Только function-объявления/var (см. 16-groupadmin.js).
var __searchIndex = null, __searchBuilding = false, __searchBuilt = false, __searchSig = new Map();

function searchChatsForIndex() {
  const out = [];
  for (const c of state.contacts.values()) if (c.messages && c.messages.length) out.push({ id: c.id, name: c.name || "", messages: c.messages });
  return out;
}
function searchChatSig(c) { const n = c.messages.length, l = n ? c.messages[n - 1] : null; return n + "|" + (l ? l.id + "|" + ((l.text || "").length) + (l.edited ? "e" : "") : ""); }
function searchBuild() {
  if (typeof MsgSearch === "undefined" || __searchBuilding) return Promise.resolve();
  __searchIndex = MsgSearch.create(); __searchBuilding = true; __searchBuilt = false;
  const chats = searchChatsForIndex();
  for (const c of chats) __searchSig.set(c.id, searchChatSig(c));
  return __searchIndex.build(chats, { sliceMs: 6 }).then(() => { __searchBuilt = true; }).catch(() => {}).then(() => { __searchBuilding = false; });
}
// Дозагрузка изменившихся чатов перед запросом (новые/удалённые/правленые сообщения), без хуков во всех местах, где меняется c.messages
function searchSync() {
  if (!__searchIndex || !__searchBuilt) return;
  for (const c of state.contacts.values()) {
    if (!c.messages) continue;
    const sig = searchChatSig(c); if (__searchSig.get(c.id) === sig) continue;
    __searchSig.set(c.id, sig);
    __searchIndex.removeChat(c.id); __searchIndex.setChatName(c.id, c.name || "");
    for (const m of c.messages) __searchIndex.addMessage(c.id, m);
  }
  for (const id of Array.from(__searchSig.keys())) if (!state.contacts.has(id)) { __searchIndex.removeChat(id); __searchSig.delete(id); }
}
function searchQueryMessages(q, extra) {
  if (!__searchIndex || !__searchBuilt) return [];
  searchSync();
  const opts = Object.assign({ limit: 40 }, extra || {});
  const gsc = document.getElementById("gs-this-chat"); if (gsc && gsc.checked && state.chatId) opts.chats = [state.chatId];
  return __searchIndex.search(q, opts);
}
function searchFmtDate(ts) { try { return new Date(ts).toLocaleDateString(document.documentElement.lang || undefined, { year: "numeric", month: "short", day: "numeric" }); } catch (e) { return ""; } }
function searchSnippetHtml(segs) { return segs.map((s) => s.hit ? "<mark>" + escapeHtml(s.t) + "</mark>" : escapeHtml(s.t)).join(""); }
// Строки раздела «Сообщения» общего поиска. null — индекс не готов (тогда работает прежний простой поиск)
function searchGlobalRows(raw) {
  if (!__searchBuilt) return null;
  const res = searchQueryMessages(raw); const html = [];
  for (const r of res) {
    const c = state.contacts.get(r.chat); if (!c) continue;
    const who = r.mine ? T("group.you") : (r.sender || (c.isGroup ? "" : c.name) || ""), plain = r.snippet.map((s) => s.t).join("");
    const label = [c.name, who, searchFmtDate(r.ts), plain].filter(Boolean).join(", ");
    html.push(`<button type="button" class="forward-row global-search-row" role="listitem" data-kind="message" data-id="${escapeHtml(r.chat)}" data-msg="${escapeHtml(r.id)}" aria-label="${escapeHtml(label)}">${avatarCircleHtml(c, "avatar-sm")}<span class="global-search-row-text"><span class="global-search-row-title">${escapeHtml(c.name || "")}<span class="fine muted"> · ${escapeHtml(who ? who + " · " : "")}${escapeHtml(searchFmtDate(r.ts))}</span></span><span class="global-search-row-subtitle muted" dir="auto">${searchSnippetHtml(r.snippet)}</span></span></button>`);
  }
  try { announceToScreenReader(T("search.msg.count", { n: html.length })); } catch (e) {}
  return html;
}
function searchPaletteItems(q) {
  if (!__searchBuilt || q.length < 2) return [];
  return searchQueryMessages(q, { limit: 5 }).map((r) => { const c = state.contacts.get(r.chat); return c ? { g: T("cmdk.messages"), label: (c.name ? c.name + ": " : "") + r.snippet.map((s) => s.t).join("").slice(0, 80), icon: "search", fn: () => jumpToMessageInChat(r.chat, r.id) } : null; }).filter(Boolean);
}
function searchJumpTo(chatId, msgId) { if (state.contacts.has(chatId)) jumpToMessageInChat(chatId, msgId); }
// Панель фильтров в общем поиске: типы, «только этот чат» и даты (в «Дополнительно»); операторы пишутся в запрос — он остаётся единственным источником правды
function searchWireUi() {
  const input = $("#global-search-input"), results = $("#global-search-results");
  if (!input || !results || $("#gs-filters")) return;
  results.setAttribute("role", "list"); results.setAttribute("aria-label", T("search.global.sectionMessages"));
  const box = document.createElement("div"); box.id = "gs-filters"; box.className = "gs-filters";
  const rerun = () => { input.dispatchEvent(new Event("input", { bubbles: true })); };
  const setOp = (key, val) => { let v = input.value.replace(new RegExp("(^|\\s)" + key + ":\\S+", "gi"), " ").replace(/\s+/g, " ").trim(); if (val) v = (v + " " + key + ":" + val).trim(); input.value = v; rerun(); };
  const types = [["", "search.type.all"], ["media", "search.type.media"], ["links", "search.type.links"], ["files", "search.type.files"], ["voice", "search.type.voice"]];
  const chips = document.createElement("div"); chips.className = "gs-chips"; chips.setAttribute("role", "group"); chips.setAttribute("aria-label", T("search.type.label"));
  for (const [v, k] of types) { const b = document.createElement("button"); b.type = "button"; b.className = "chip gs-chip"; b.textContent = T(k); b.setAttribute("aria-pressed", "false"); b.dataset.type = v; b.addEventListener("click", () => { setOp("type", v); for (const x of chips.children) x.setAttribute("aria-pressed", x === b ? "true" : "false"); }); chips.appendChild(b); }
  box.appendChild(chips);
  const det = document.createElement("details"); const sm = document.createElement("summary"); sm.textContent = T("group.admin.advanced"); det.appendChild(sm);
  const lab = (text, el) => { const l = document.createElement("label"); l.className = "settings-row"; const s = document.createElement("span"); s.textContent = text; l.appendChild(s); l.appendChild(el); det.appendChild(l); };
  const mkDate = (key, text) => { const d = document.createElement("input"); d.type = "date"; d.setAttribute("aria-label", text); d.addEventListener("change", () => setOp(key, d.value)); lab(text, d); };
  mkDate("after", T("search.after")); mkDate("before", T("search.before"));
  const tc = document.createElement("input"); tc.type = "checkbox"; tc.id = "gs-this-chat"; tc.className = "switch"; tc.addEventListener("change", rerun); lab(T("search.thisChat"), tc);
  const hint = document.createElement("p"); hint.className = "fine muted"; hint.textContent = T("search.operatorsHint"); det.appendChild(hint);
  box.appendChild(det);
  results.parentNode.insertBefore(box, results);
  setTimeout(() => { searchBuild(); }, 1500); // не мешаем запуску: индекс строится порциями в фоне
}
