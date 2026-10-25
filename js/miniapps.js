// Мини-приложения в чате (V.80): небольшие встроенные программы (общий чек-лист, кубик) в изолированном <iframe>.
//
// Модель безопасности (честно, что это и чем не является):
//  * Код приложения лежит в репозитории рядом с оболочкой (miniapps/<id>/…) и грузится ТОЛЬКО с того же origin: CSP оболочки (default-src 'self')
//    не разрешает ни внешние адреса в iframe, ни srcdoc/blob с исполняемым кодом. Запуск чужих мини-приложений по ссылке в v1 намеренно НЕ поддержан.
//  * iframe с sandbox="allow-scripts" БЕЗ allow-same-origin: непрозрачное происхождение — у приложения нет доступа к localStorage/IndexedDB/cookie/DOM
//    оболочки, ключам и сессиям; нет allow-forms/popups/top-navigation/modals; собственный CSP страницы: default-src 'none', script-src 'self', без сети.
//  * Единственный канал — MessagePort, выданный хостом после рукопожатия (postMessage hello/init). Методы моста и права перечислены в BRIDGE_METHODS:
//    state.get/state.set (право storage), share (sync: отправить состояние участникам чата по обычному E2E-каналу, kind "miniapp"),
//    chat.post (отправить текст от моего имени; КАЖДЫЙ раз отдельное подтверждение), ui.resize.
//  * Права запрашиваются у человека явно при первом запуске в данном чате (окно подтверждения со списком прав) и запоминаются на пару «чат + приложение».
//  * Полученное от собеседника состояние (kind "miniapp") — недоверенные данные: проверяется приложение из реестра, право sync, размер ≤ 8000 символов JSON,
//    частота; приложению оно отдаётся только после того, как человек сам открыл приложение и дал права.
//
// Манифест (v:1): { v:1, id:"[a-z0-9-]{2,32}", name:{en,ru}, desc:{en,ru}, entry:"miniapps/<id>/index.html" (относительный путь без «..», только то же origin),
//                   permissions:["storage"|"sync"|"chat.post"], height:120..560 }.
// В меню вложений ровно один пункт («Мини-приложения»); он добавляется скриптом при загрузке (если пункта ещё нет). Строки интерфейса — только en/ru (здесь, а не в js/lang).
(function (root) {
  "use strict";
  const STR = {
    en: { menu: "Mini-apps", title: "Mini-apps", close: "Close", allow: "Allow", send: "Send", permsAsk: "“{app}” asks for:\n{list}\n\nIt runs in an isolated sandbox with no network access.",
      "perm.storage": "• keep its data on this device for this chat", "perm.sync": "• share its data with everyone in this chat (end-to-end encrypted)", "perm.chat.post": "• send messages from you (you confirm each one)",
      confirmPost: "“{app}” wants to send this message from you:\n\n{text}", updated: "{name} updated “{app}”", sandboxNote: "Runs in an isolated sandbox. Only apps bundled with the app can run." },
    ru: { menu: "Мини-приложения", title: "Мини-приложения", close: "Закрыть", allow: "Разрешить", send: "Отправить", permsAsk: "«{app}» запрашивает:\n{list}\n\nРаботает в изолированной песочнице без доступа к сети.",
      "perm.storage": "• хранить свои данные на этом устройстве для этого чата", "perm.sync": "• делиться своими данными со всеми в этом чате (со сквозным шифрованием)", "perm.chat.post": "• отправлять сообщения от вашего имени (каждое вы подтверждаете)",
      confirmPost: "«{app}» хочет отправить от вашего имени:\n\n{text}", updated: "{name} изменил(а) «{app}»", sandboxNote: "Работает в изолированной песочнице. Запускаются только приложения из состава приложения." },
  };
  const PERMS = ["storage", "sync", "chat.post"];
  const LIM = { state: 16000, share: 8000, post: 500, hMin: 120, hMax: 560, shareGapMs: 800, recvGapMs: 300, inboxPerKey: 8 };
  const BUILTIN = [
    { v: 1, id: "checklist", name: { en: "Shared checklist", ru: "Общий чек-лист" }, desc: { en: "Items everyone in the chat can add and tick off", ru: "Пункты, которые могут добавлять и отмечать все в чате" }, entry: "miniapps/checklist/index.html", permissions: ["storage", "sync"], height: 380 },
    { v: 1, id: "dice", name: { en: "Dice", ru: "Кубик" }, desc: { en: "Roll a die and send the result to the chat", ru: "Бросить кубик и отправить результат в чат" }, entry: "miniapps/dice/index.html", permissions: ["chat.post"], height: 300 },
  ];
  const BRIDGE_METHODS = { "state.get": "storage", "state.set": "storage", share: "sync", "chat.post": "chat.post", "ui.resize": null };

  function validateManifest(m) {
    const bad = (e) => ({ ok: false, error: e });
    if (!m || typeof m !== "object" || m.v !== 1) return bad("version");
    if (typeof m.id !== "string" || !/^[a-z0-9-]{2,32}$/.test(m.id)) return bad("id");
    for (const k of ["name", "desc"]) if (!m[k] || typeof m[k].en !== "string" || !m[k].en || m[k].en.length > 120 || (m[k].ru != null && typeof m[k].ru !== "string")) return bad(k);
    if (typeof m.entry !== "string" || !/^miniapps\/[a-z0-9-]+\/[a-z0-9._-]+\.html$/.test(m.entry) || m.entry.includes("..")) return bad("entry");
    if (!Array.isArray(m.permissions) || m.permissions.length > PERMS.length || !m.permissions.every((p, i) => PERMS.includes(p) && m.permissions.indexOf(p) === i)) return bad("permissions");
    if (!Number.isInteger(m.height) || m.height < LIM.hMin || m.height > LIM.hMax) return bad("height");
    return { ok: true };
  }
  const byId = (id) => BUILTIN.find((m) => m.id === id) || null;

  // JSON-объект приложения -> копия или null (не объект / не сериализуется / больше лимита)
  function clean(v, max) {
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    try { const s = JSON.stringify(v); return s.length <= max ? JSON.parse(s) : null; } catch (e) { return null; }
  }

  // ---------- окружение (подменяется в тестах) ----------
  function defaultEnv() {
    const g = root, ls = (() => { try { return g.localStorage; } catch (e) { return null; } })();
    const rd = (k) => { try { const v = ls && ls.getItem(k); return v ? JSON.parse(v) : {}; } catch (e) { return {}; } };
    const wr = (k, o) => { try { ls && ls.setItem(k, JSON.stringify(o)); return true; } catch (e) { return false; } };
    return {
      win: g, doc: g.document, rd, wr,
      lang: () => { try { const l = (typeof I18n !== "undefined" && I18n.getLanguage && I18n.getLanguage()) || g.document.documentElement.lang || "en"; return String(l).toLowerCase().startsWith("ru") ? "ru" : "en"; } catch (e) { return "en"; } },
      toast: (s) => { try { if (typeof toast === "function") toast(s); } catch (e) {} },
      confirm: (msg, ok) => (typeof confirmSheet === "function" ? confirmSheet(msg, { okLabel: ok }) : Promise.resolve(false)),
      chatId: () => (typeof state !== "undefined" ? state.chatId : null),
      contact: (id) => (typeof state !== "undefined" ? state.contacts.get(id) : null),
      container: (from, payload) => (typeof richContainer === "function" ? richContainer(from, payload, false) : null),
      myId: () => (typeof Store !== "undefined" ? Store.myId : ""),
      name: (id) => { const c = typeof state !== "undefined" && state.contacts.get(id); return (c && c.name) || ""; },
      sendRich: async (c, payload) => {
        if (c.blocked) throw new Error("blocked");
        if (typeof isGroup === "function" && isGroup(c) && typeof isGroupWriteAllowed === "function" && !isGroupWriteAllowed(c, Store.myId)) throw new Error("group-readonly");
        await dispatchRich(c, payload);
      },
      sendText: async (c, text) => { if (c.blocked) throw new Error("blocked"); if (typeof isGroup === "function" && isGroup(c)) await sendGroupMessage(c.id, text); else await sendChatMessage(c.id, text); },
      now: () => Date.now(), uuid: () => (g.crypto && g.crypto.randomUUID ? g.crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()),
    };
  }
  let ENV = null;
  const env = () => ENV || (ENV = defaultEnv());
  const tr = (k, vars) => { const l = env().lang(); let s = (STR[l] && STR[l][k]) || STR.en[k] || k; if (vars) for (const x of Object.keys(vars)) s = s.split("{" + x + "}").join(vars[x]); return s; };
  const pick = (o) => (o && (o[env().lang()] || o.en)) || "";

  // ---------- хранилище ----------
  const K_STATE = "ether.miniapps.state", K_PERMS = "ether.miniapps.perms", K_INBOX = "ether.miniapps.inbox";
  const keyOf = (chatId, appId) => chatId + "|" + appId;
  const loadState = (key) => { const e = env().rd(K_STATE)[key]; return e && e.st ? e.st : null; };
  function saveState(key, st) { const all = env().rd(K_STATE); all[key] = { st, ts: env().now() }; return env().wr(K_STATE, all); }
  const grantedOf = (key) => { const g = env().rd(K_PERMS)[key]; return Array.isArray(g) ? g.filter((p) => PERMS.includes(p)) : []; };
  function setGranted(key, list) { const all = env().rd(K_PERMS); all[key] = list; env().wr(K_PERMS, all); }
  function forget(chatId, appId) { const all = env().rd(K_PERMS); delete all[keyOf(chatId, appId)]; env().wr(K_PERMS, all); }

  // ---------- мост: вызовы приложения ----------
  // s = { key, chatId, manifest, granted:Set, lastShare }
  function need(s, perm) { if (perm && !s.granted.has(perm)) throw new Error("permission-denied:" + perm); }
  async function handle(s, method, a) {
    if (!Object.prototype.hasOwnProperty.call(BRIDGE_METHODS, method)) throw new Error("unknown-method");
    need(s, BRIDGE_METHODS[method]);
    a = a && typeof a === "object" ? a : {};
    const e = env();
    switch (method) {
      case "state.get": return loadState(s.key);
      case "state.set": { const st = clean(a.state, LIM.state); if (!st) throw new Error("bad-state"); if (!saveState(s.key, st)) throw new Error("storage-failed"); return true; }
      case "share": {
        const st = clean(a.state, LIM.share); if (!st) throw new Error("bad-state");
        const now = e.now(); if (s.lastShare && now - s.lastShare < LIM.shareGapMs) throw new Error("rate");
        s.lastShare = now;
        const c = e.contact(s.chatId); if (!c) throw new Error("no-chat");
        await e.sendRich(c, { kind: "miniapp", id: e.uuid(), ts: now, app: s.manifest.id, st });
        return true;
      }
      case "chat.post": {
        const text = String(a.text == null ? "" : a.text).trim().slice(0, LIM.post); if (!text) throw new Error("bad-text");
        if (!(await e.confirm(tr("confirmPost", { app: pick(s.manifest.name), text }), tr("send")))) throw new Error("denied"); // подтверждение КАЖДОГО сообщения
        const c = e.contact(s.chatId); if (!c) throw new Error("no-chat");
        await e.sendText(c, text);
        return true;
      }
      case "ui.resize": { const h = Math.max(LIM.hMin, Math.min(LIM.hMax, Number(a.height) | 0)); if (s.onResize) s.onResize(h); return h; }
    }
  }

  // ---------- входящие ----------
  const lastRecv = new Map(), SESSIONS = new Map(); // key -> session (открытое приложение)
  function receive(from, payload) {
    const e = env();
    if (typeof from !== "string" || !payload || typeof payload !== "object") return false;
    const man = byId(payload.app); if (!man || !man.permissions.includes("sync")) return false;
    const st = clean(payload.st, LIM.share); if (!st) return false;
    const c = e.container(from, payload); if (!c || c.blocked) return false;
    const key = keyOf(c.id, man.id), gk = key + "|" + from, now = e.now();
    if (now - (lastRecv.get(gk) || 0) < LIM.recvGapMs) return false;
    lastRecv.set(gk, now); if (lastRecv.size > 500) lastRecv.delete(lastRecv.keys().next().value);
    const open = SESSIONS.get(key);
    if (open && open.port) { try { open.port.postMessage({ t: "remote", st, from }); } catch (err) {} return true; }
    const inbox = e.rd(K_INBOX), box = inbox[key] || (inbox[key] = {});
    box[from] = { st, ts: now };
    const ids = Object.keys(box); while (ids.length > LIM.inboxPerKey) delete box[ids.shift()];
    e.wr(K_INBOX, inbox);
    e.toast(tr("updated", { name: e.name(from) || from.slice(0, 8), app: pick(man.name) }));
    return true;
  }
  function takeInbox(key) { const all = env().rd(K_INBOX), box = all[key]; if (!box) return []; delete all[key]; env().wr(K_INBOX, all); return Object.keys(box).map((f) => ({ from: f, st: box[f].st })); }

  // ---------- интерфейс ----------
  function injectStyle(doc) {
    if (doc.getElementById("miniapp-style")) return;
    const st = doc.createElement("style"); st.id = "miniapp-style";
    st.textContent = ".miniapp-frame{width:100%;border:0;border-radius:12px;background:transparent;display:block}.miniapp-title{font-weight:600;padding:4px 4px 8px}.miniapp-note{font-size:12px;opacity:.7;padding:6px 4px}.miniapp-item{display:block;width:100%;text-align:start}.miniapp-item small{display:block;opacity:.7}";
    doc.head.appendChild(st);
  }
  function makeSheet(doc, title) {
    injectStyle(doc);
    const sh = doc.createElement("div"); sh.className = "sheet"; sh.setAttribute("role", "dialog"); sh.setAttribute("aria-modal", "true");
    const bd = doc.createElement("div"); bd.className = "sheet-backdrop";
    const panel = doc.createElement("div"); panel.className = "sheet-panel glass-content";
    const h = doc.createElement("div"); h.className = "sheet-handle";
    const ti = doc.createElement("div"); ti.className = "miniapp-title"; ti.textContent = title;
    const close = doc.createElement("button"); close.type = "button"; close.className = "btn-tertiary sheet-cancel"; close.textContent = tr("close");
    panel.append(h, ti, close); sh.append(bd, panel); doc.body.appendChild(sh);
    const shut = () => { if (sh.parentNode) sh.parentNode.removeChild(sh); if (sh._onClose) sh._onClose(); };
    bd.addEventListener("click", shut); close.addEventListener("click", shut);
    return { sh, panel, shut, close };
  }

  async function ensureGranted(key, man) {
    const have = grantedOf(key);
    if (man.permissions.every((p) => have.includes(p))) return true;
    const list = man.permissions.map((p) => tr("perm." + p)).join("\n");
    if (!(await env().confirm(tr("permsAsk", { app: pick(man.name), list }), tr("allow")))) return false;
    setGranted(key, man.permissions.slice());
    return true;
  }

  // Запуск приложения в чате chatId. Возвращает сессию (или null, если человек отказал в правах).
  async function launch(chatId, appId) {
    const e = env(), man = byId(appId), doc = e.doc;
    if (!man || !validateManifest(man).ok || !chatId) return null;
    const key = keyOf(chatId, man.id);
    if (SESSIONS.has(key)) return SESSIONS.get(key);
    if (!(await ensureGranted(key, man))) return null;
    const { sh, panel, shut, close } = makeSheet(doc, pick(man.name));
    const iframe = doc.createElement("iframe");
    iframe.className = "miniapp-frame"; iframe.setAttribute("sandbox", "allow-scripts"); // БЕЗ allow-same-origin
    iframe.setAttribute("referrerpolicy", "no-referrer"); iframe.setAttribute("allow", ""); iframe.setAttribute("title", pick(man.name));
    iframe.style.height = man.height + "px";
    const note = doc.createElement("div"); note.className = "miniapp-note"; note.textContent = tr("sandboxNote");
    panel.insertBefore(iframe, close); panel.insertBefore(note, close);
    const s = { key, chatId, manifest: man, granted: new Set(man.permissions), iframe, port: null, onResize: (h) => { iframe.style.height = h + "px"; } };
    SESSIONS.set(key, s);
    const onMsg = (ev) => {
      if (s.port || ev.source !== iframe.contentWindow || !ev.data || ev.data.ether !== "miniapp-hello") return;
      const ch = new e.win.MessageChannel(); s.port = ch.port1;
      ch.port1.onmessage = (m) => {
        const d = m.data || {}; if (typeof d.id !== "number" || typeof d.m !== "string") return;
        handle(s, d.m, d.a).then((r) => ch.port1.postMessage({ t: "res", id: d.id, ok: true, r: r === undefined ? null : r }), (err) => ch.port1.postMessage({ t: "res", id: d.id, ok: false, err: String(err && err.message || err).slice(0, 80) }));
      };
      iframe.contentWindow.postMessage({ ether: "miniapp-init", v: 1, app: man.id, lang: e.lang(), perms: man.permissions, state: s.granted.has("storage") ? loadState(key) : null, inbox: s.granted.has("sync") ? takeInbox(key) : [] }, "*", [ch.port2]);
    };
    e.win.addEventListener("message", onMsg);
    sh._onClose = () => { e.win.removeEventListener("message", onMsg); try { s.port && s.port.close(); } catch (err) {} s.port = null; SESSIONS.delete(key); };
    iframe.src = new URL(man.entry, doc.baseURI).href;
    s.shut = shut; s.sheet = sh;
    return s;
  }

  async function openPicker() {
    const e = env(), chatId = e.chatId(); if (!chatId) return null;
    const { sh, panel, shut, close } = makeSheet(e.doc, tr("title"));
    for (const man of BUILTIN) {
      const b = e.doc.createElement("button"); b.type = "button"; b.className = "sheet-action miniapp-item"; b.dataset.miniapp = man.id;
      b.textContent = pick(man.name); const sm = e.doc.createElement("small"); sm.textContent = pick(man.desc); b.appendChild(sm);
      b.addEventListener("click", () => { shut(); launch(chatId, man.id).catch(() => {}); });
      panel.insertBefore(b, close);
    }
    return sh;
  }

  // Ровно один пункт в меню вложений; повторный вызов ничего не добавляет.
  function addMenuEntry() {
    const e = env(), doc = e.doc, menu = doc.querySelector("#composer-menu-sheet .composer-menu-actions");
    if (!menu || menu.querySelector("[data-miniapp-entry]")) return null;
    const b = doc.createElement("button"); b.type = "button"; b.id = "chat-miniapp-btn"; b.className = "sheet-action composer-menu-item"; b.setAttribute("data-menu-more", ""); b.setAttribute("data-miniapp-entry", "1");
    const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("data-icon", "code"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", "22"); svg.setAttribute("height", "22"); svg.setAttribute("aria-hidden", "true");
    const sp = doc.createElement("span"); sp.textContent = tr("menu");
    b.append(svg, sp);
    const more = menu.querySelector("#composer-menu-more");
    menu.insertBefore(b, more || null);
    try { if (typeof Icons !== "undefined" && Icons.hydrate) Icons.hydrate(b); } catch (err) {}
    b.addEventListener("click", () => {
      const sheet = doc.getElementById("composer-menu-sheet"); if (sheet) sheet.classList.add("hidden");
      try { if (typeof collapseComposerPlus === "function") collapseComposerPlus(); } catch (err) {}
      openPicker().catch(() => {});
    });
    return b;
  }

  const api = { BUILTIN, PERMS, LIM, BRIDGE_METHODS, STR, validateManifest, byId, clean, handle, receive, launch, openPicker, addMenuEntry, forget, _sessions: SESSIONS, _setEnv(e) { ENV = e; }, _takeInbox: takeInbox,
    init() { try { addMenuEntry(); } catch (err) {} } };
  root.EtherMiniApps = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root.document && typeof root.addEventListener === "function" && !root.__MINIAPPS_NO_AUTOINIT) {
    if (root.document.readyState === "loading") root.document.addEventListener("DOMContentLoaded", api.init); else api.init();
  }
})(typeof window !== "undefined" ? window : globalThis);
