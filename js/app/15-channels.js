"use strict";
// V.80: каналы (рассылка один-ко-многим). Криптография и ссылки — js/channels.js (Channels), сервер — signaling-server/channels.js.
// Канал в списке чатов — запись-«группа» с isChannel (id "ch-<id>"): подписчик не входит в writers (только чтение, реакции локально, комментариев нет),
// владелец видит композер. Каждый пост проверяется подписью закреплённого ключа владельца; при неудаче — баннер, пост не показывается.
// Только function-объявления (см. 16-groupadmin.js).
var __chPending = new Map();   // id -> { hash, key, at } — ожидаем channel-info после подписки по ссылке
var __chCreating = new Map();  // id -> канал в процессе создания (локальная запись до ответа сервера)
var CH_MEGAPHONE_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1z"/><path d="M15 9a4 4 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/></svg>';

function channelEntry(chid) { return state.contacts.get("ch-" + chid) || null; }
function channelOps() { return !!(typeof signaling !== "undefined" && signaling && signaling.connected && signaling.registered && Array.isArray(signaling.features) && signaling.features.includes("channels")); }
function channelSend(type, payload) { return channelOps() && signaling.channelOp(type, payload); }
function channelMakeEntry(info, owner) {
  const id = "ch-" + info.id, meta = info.meta || {};
  const g = {
    id, isGroup: true, isChannel: true, name: meta.name || T("channel.defaultName"), description: meta.desc || "", members: owner ? [{ id: Store.myId, name: Store.name || T("sys.someone"), role: "admin" }] : [],
    messages: [], lastActivity: Date.now(), archived: false, muted: false, managed: true, writeRestricted: true, createdBy: owner ? Store.myId : "channel:" + info.id,
    ch: { id: info.id, pub: info.pub, pubHash: info.pubHash, kv: meta.kv | 0, key: info.key || null, seq: 0, owner: !!owner, subs: 0, sigFail: 0, enc: !!meta.enc },
  };
  if (meta.avatar && AVATAR_DATAURL_RE.test(meta.avatar)) g.avatar = meta.avatar;
  if (owner) g.ch.priv = info.priv;
  return g;
}
// ---- создание ----
async function channelCreate(name, desc, enc, avatar) {
  if (!channelOps()) { toast(T("channel.needServer")); return null; }
  name = String(name || "").trim().slice(0, 60); if (!name) { toast(T("channel.needName")); return null; }
  const c = await Channels.generate({ name, desc: String(desc || "").trim().slice(0, 200), enc: !!enc, avatar });
  const g = channelMakeEntry({ id: c.id, pub: c.pub, pubHash: c.pubHash, meta: c.meta, key: c.key, priv: c.priv }, true);
  g.ch.metaSig = c.metaSig;
  __chCreating.set(c.id, g);
  channelSend("channel-create", { ch: c.id, pub: c.pub, meta: c.meta, metaSig: c.metaSig });
  setTimeout(() => { if (__chCreating.delete(c.id)) toast(T("channel.createFailed")); }, 10000);
  return c.id;
}
// ---- подписка по ссылке ----
function channelSubscribeFromLink(text) {
  const l = Channels.parseLink(text); if (!l) { toast(T("channel.badLink")); return false; }
  const ex = channelEntry(l.id);
  if (ex) { toast(T("channel.alreadyJoined")); channelOpen(ex.id); return true; }
  if (!channelOps()) { toast(T("channel.needServer")); return false; }
  __chPending.set(l.id, { hash: l.hash, key: l.key, at: Date.now() });
  channelSend("channel-subscribe", { ch: l.id });
  setTimeout(() => { if (__chPending.delete(l.id)) toast(T("channel.subscribeFailed")); }, 10000);
  return true;
}
function channelOpen(id) { resetChatTransientState(id); state.tab = "chats"; state.chatId = id; state.contactCardId = null; renderTab(); }
function channelOpenLink(hash) { // из location.hash: подтверждение, затем подписка
  const l = Channels.parseLink(hash); if (!l) return;
  Promise.resolve().then(() => confirmSheet(T("channel.confirmJoin"))).then((ok) => { if (ok) channelSubscribeFromLink(hash); }).catch(() => {});
}
function channelInviteLink(g) {
  const base = location.href.split("#")[0];
  return base + "#" + Channels.fragment({ id: g.ch.id, pubHash: g.ch.pubHash, key: g.ch.owner ? g.ch.key : g.ch.key });
}
// ---- ответы сервера ----
async function channelOnInfo(d) {
  const pend = __chPending.get(d.ch), ex = channelEntry(d.ch);
  if (d.error) { if (pend) { __chPending.delete(d.ch); toast(T("channel.err." + (["not-found", "full", "limit", "rate"].includes(d.error) ? d.error : "other"))); } return; }
  if (!d.pub || !d.meta) return;
  if (ex) { // обновление меты существующего канала: только подписанная закреплённым ключом
    if (!(await Channels.verifyMeta(d.ch, ex.ch.pub, d.meta, d.metaSig))) { channelSigFail(ex); return; }
    channelApplyMeta(ex, d.meta); ex.ch.subs = d.subs | 0; persistContacts(); return;
  }
  if (!pend) return;
  __chPending.delete(d.ch);
  if ((await Channels.pubHash(d.pub)) !== pend.hash || !(await Channels.verifyMeta(d.ch, d.pub, d.meta, d.metaSig))) { toast(T("channel.keyMismatch")); try { channelSend("channel-unsubscribe", { ch: d.ch }); } catch (e) {} return; }
  const g = channelMakeEntry({ id: d.ch, pub: d.pub, pubHash: pend.hash, meta: d.meta, key: pend.key }, false);
  g.ch.subs = d.subs | 0; g.ch.metaSig = d.metaSig;
  g.messages.push({ id: crypto.randomUUID(), from: "system", text: T("channel.systemJoined", { name: g.name }), textKey: "channel.systemJoined", textParams: { name: g.name }, ts: Date.now() });
  state.contacts.set(g.id, g); persistContacts();
  channelSend("channel-history", { ch: d.ch, since: 0 });
  toast(T("channel.joined", { name: g.name }));
  if (state.tab === "chats") renderChatsList();
  channelOpen(g.id);
}
function channelApplyMeta(g, meta) {
  g.name = meta.name || g.name; g.description = meta.desc || ""; g.ch.enc = !!meta.enc;
  if (meta.avatar && AVATAR_DATAURL_RE.test(meta.avatar)) g.avatar = meta.avatar; else if (!meta.avatar && !g.ch.owner) delete g.avatar;
  if ((meta.kv | 0) !== g.ch.kv && !g.ch.owner) { g.ch.keyStale = true; } // владелец сменил ключ: нужна новая ссылка
  g.ch.metaTs = meta.ts;
}
function channelSigFail(g) {
  g.ch.sigFail = (g.ch.sigFail | 0) + 1; g.ch.sigFailAt = Date.now(); persistContacts();
  if (state.chatId === g.id) try { renderChatThread(); } catch (e) {}
}
async function channelIngest(chid, seq, post, live) {
  const g = channelEntry(chid); if (!g) return;
  if (g.messages.some((m) => m.id === post.id)) { if (seq > g.ch.seq) g.ch.seq = seq; return; }
  const r = await Channels.openPost(g.ch, post);
  if (!r.ok) { channelSigFail(g); return; }
  const mine = g.ch.owner;
  const rec = { id: post.id, from: mine ? "me" : "them", text: "", ts: Math.min(post.ts, Date.now() + 60000), readAckSent: mine, chSeq: seq };
  if (r.content) { rec.text = r.content.text; if (r.content.media) rec.chMedia = r.content.media.dataUrl; if (r.content.reply) { const o = g.messages.find((x) => x.id === r.content.reply); if (o) rec.replyTo = { id: o.id, text: (o.text || "").slice(0, 200), authorName: g.name }; } }
  else { rec.text = T("channel.locked"); rec.chLocked = true; }
  if (mine) { rec.ack = "sent"; rec.serverAcked = true; }
  g.messages.push(rec); g.messages.sort((a, b) => a.ts - b.ts); trimMessages(g);
  g.lastActivity = Math.max(g.lastActivity || 0, rec.ts); if (seq > g.ch.seq) g.ch.seq = seq;
  persistContacts();
  try { if (typeof MsgSearch !== "undefined" && typeof __searchIndex !== "undefined" && __searchIndex) __searchIndex.addMessage(g.id, rec); } catch (e) {}
  if (state.chatId === g.id) { renderChatThread(); if (live && !mine) { playMessageSound(g.id); announceToScreenReader(T("sr.newMessage", { name: g.name, text: truncate(rec.text, 80) })); } }
  else if (live && !mine) { if (!isContactMuted(g)) { toast(g.name + ": " + truncate(rec.text, 40)); showNotification(g.name, truncate(rec.text, 80), { tag: "ether-msg-" + g.id, contactId: g.id, kind: "message" }); playMessageSound(g.id); } }
  if (state.tab === "chats") renderChatsList();
}
function channelsWire(sig, on, subs) {
  subs.push(on("channel-created", (ev) => {
    const d = ev.detail, g = __chCreating.get(d.ch); if (!g) return;
    __chCreating.delete(d.ch);
    if (d.error) { toast(T("channel.err." + (["exists", "limit", "full", "rate"].includes(d.error) ? d.error : "other"))); return; }
    g.messages.push({ id: crypto.randomUUID(), from: "system", text: T("channel.systemCreated", { name: g.name }), textKey: "channel.systemCreated", textParams: { name: g.name }, ts: Date.now() });
    state.contacts.set(g.id, g); persistContacts(); channelOpen(g.id);
  }));
  subs.push(on("channel-info", (ev) => { channelOnInfo(ev.detail).catch(() => {}); }));
  subs.push(on("channel-post", (ev) => { const d = ev.detail; if (d && d.post && Number.isInteger(d.seq)) channelIngest(d.ch, d.seq, d.post, true).catch(() => {}); }));
  subs.push(on("channel-history", (ev) => {
    const d = ev.detail; if (!d || d.error || !Array.isArray(d.posts)) return;
    (async () => { for (const p of d.posts) if (p && p.post) await channelIngest(d.ch, p.seq, p.post, false); })().catch(() => {});
  }));
  subs.push(on("channel-post-ack", (ev) => {
    const d = ev.detail, g = d && channelEntry(d.ch); if (!g) return;
    const m = g.messages.find((x) => x.id === d.id); if (!m) return;
    if (d.error && !d.dup) { m.ack = "failed"; toast(T("channel.postFailed", { reason: d.error })); } else { m.ack = "sent"; m.serverAcked = true; if (d.seq && d.seq > g.ch.seq) g.ch.seq = d.seq; }
    persistContacts(); if (state.chatId === g.id) renderChatThread();
  }));
  subs.push(on("channel-meta-update", (ev) => {
    const d = ev.detail, g = channelEntry(d.ch); if (!g || g.ch.owner) return;
    Channels.verifyMeta(g.ch.id, g.ch.pub, d.meta, d.metaSig).then((ok) => { if (!ok) return channelSigFail(g); channelApplyMeta(g, d.meta); persistContacts(); if (state.tab === "chats") renderChatsList(); if (state.chatId === g.id) renderChatThread(); }).catch(() => {});
  }));
  subs.push(on("channel-gone", (ev) => { const g = channelEntry(ev.detail.ch); if (g && !g.ch.owner) { g.ch.gone = true; persistContacts(); toast(T("channel.gone", { name: g.name })); if (state.chatId === g.id) renderChatThread(); } }));
  subs.push(on("channel-unsubscribed", () => {}));
  subs.push(on("registered", () => { channelsResync(); }));
}
function channelsResync() { // после (пере)подключения: догрузить посты, пропущенные офлайн, и обновить мету
  if (!channelOps()) return;
  for (const g of state.contacts.values()) if (g.isChannel && g.ch && !g.ch.gone) { channelSend("channel-history", { ch: g.ch.id, since: g.ch.seq | 0 }); channelSend("channel-info", { ch: g.ch.id }); }
}
// ---- публикация (владелец) ----
async function channelSendPost(g, text, replyTo, mediaDataUrl) {
  if (!g.ch || !g.ch.owner) { toast(T("channel.readOnly")); return false; }
  text = String(text || "").slice(0, 8000); if (!text.trim() && !mediaDataUrl) return false;
  if (!channelOps()) { toast(T("channel.needServer")); return false; }
  const content = { text }; if (mediaDataUrl) content.media = { dataUrl: mediaDataUrl }; if (replyTo && replyTo.msgId) content.reply = replyTo.msgId;
  let post; try { post = await Channels.makePost(g.ch, content); } catch (e) { toast(T("channel.postTooBig")); return false; }
  await channelIngestLocal(g, post, content);
  channelSend("channel-post", { ch: g.ch.id, post });
  return true;
}
async function channelIngestLocal(g, post, content) {
  const rec = { id: post.id, from: "me", text: content.text, ts: post.ts, readAckSent: true, ack: "pending" };
  if (content.media) rec.chMedia = content.media.dataUrl;
  g.messages.push(rec); trimMessages(g); g.lastActivity = post.ts; persistContacts();
  try { if (typeof __searchIndex !== "undefined" && __searchIndex) __searchIndex.addMessage(g.id, rec); } catch (e) {}
  if (state.chatId === g.id) { renderChatThreadInner(); const w = $("#chat-messages"); if (w) w.scrollTop = w.scrollHeight; }
  if (state.tab === "chats") renderChatsList();
}
async function channelPostImage(g, file) {
  for (const size of [720, 480, 320]) {
    const url = await readImageAsAvatarDataUrl(file, size);
    if (url.length <= Channels.MAX_MEDIA) return channelSendPost(g, ($("#chat-input") || {}).value || "", null, url);
  }
  toast(T("channel.imageTooBig")); return false;
}
// ---- оформление чата канала ----
function channelUpdateChrome(c) { // вызывается из renderChatThread для каждого чата
  const isCh = !!(c && c.isChannel);
  for (const id of ["chat-call-btn", "chat-video-btn"]) { const b = document.getElementById(id); if (b && isCh) { b.disabled = true; b.classList.add("hidden"); } else if (b && b.classList.contains("hidden") && b.dataset.chHidden) { b.classList.remove("hidden"); delete b.dataset.chHidden; } if (b && isCh) b.dataset.chHidden = "1"; }
  const composer = $("#chat-input") && $("#chat-input").closest("form, .composer, .chat-composer");
  let ban = $("#chat-channel-banner");
  if (!isCh) { if (ban) ban.remove(); return; }
  const st = $("#chat-peer-status"); if (st) st.textContent = T("channel.subscribers", { n: Math.max(c.ch.subs | 0, c.ch.owner ? 1 : 0) });
  if (!c.ch.owner) { for (const id of ["chat-attach-btn", "chat-camera-btn", "chat-mic-btn"]) { const b = document.getElementById(id); if (b) b.classList.add("hidden"); } const ci = $("#chat-input"); if (ci) ci.placeholder = T("channel.composerReadOnly"); }
  const msgs = $("#chat-messages"); if (!msgs || !msgs.parentNode) return;
  const notes = [];
  if (c.ch.sigFail > 0 && Date.now() - (c.ch.sigFailAt || 0) < 7 * 86400000) notes.push(T("channel.sigFailBanner"));
  if (c.ch.gone) notes.push(T("channel.goneBanner"));
  if (c.ch.keyStale && !c.ch.owner) notes.push(T("channel.keyStaleBanner"));
  if (!notes.length) { if (ban) ban.remove(); return; }
  if (!ban) { ban = document.createElement("div"); ban.id = "chat-channel-banner"; ban.className = "channel-banner"; ban.setAttribute("role", "alert"); msgs.parentNode.insertBefore(ban, msgs); }
  ban.textContent = notes.join(" · ");
}
function channelMediaHtml(m) { return AVATAR_DATAURL_RE.test(m.chMedia || "") || /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(m.chMedia || "") ? `<img class="channel-media" src="${m.chMedia}" alt="${escapeHtml(T("channel.imageAlt"))}" loading="lazy" />` + (m.text ? `<div>${linkifyAndHighlight(m.text, "")}</div>` : "") : ""; }
// ---- сведения о канале ----
function openChannelInfo(g) {
  state.activeGroupContext = g.id;
  let sheet = $("#channel-info-sheet");
  if (!sheet) {
    sheet = document.createElement("div"); sheet.id = "channel-info-sheet"; sheet.className = "sheet hidden"; sheet.setAttribute("role", "dialog"); sheet.setAttribute("aria-modal", "true");
    sheet.innerHTML = '<div class="sheet-backdrop"></div><div class="sheet-panel glass-content"><div class="sheet-handle"></div><div id="channel-info-body"></div><button type="button" class="btn-tertiary sheet-cancel" data-close-sheet="channel-info-sheet"></button></div>';
    document.body.appendChild(sheet);
    sheet.querySelector(".sheet-cancel").textContent = T("sys.close"); sheet.querySelector(".sheet-backdrop").addEventListener("click", () => sheet.classList.add("hidden"));
    sheet.querySelector(".sheet-cancel").addEventListener("click", () => sheet.classList.add("hidden"));
  }
  const body = sheet.querySelector("#channel-info-body"); body.innerHTML = "";
  const h = document.createElement("h2"); h.textContent = g.name; body.appendChild(h);
  if (g.description) { const p = document.createElement("p"); p.className = "fine muted"; p.textContent = g.description; body.appendChild(p); }
  const meta = document.createElement("p"); meta.className = "fine muted"; meta.textContent = T("channel.subscribers", { n: Math.max(g.ch.subs | 0, g.ch.owner ? 1 : 0) }) + " · " + T(g.ch.enc ? "channel.private" : "channel.public"); body.appendChild(meta);
  const btn = (label, fn, cls) => { const b = document.createElement("button"); b.type = "button"; b.className = cls || "btn-secondary"; b.textContent = label; b.addEventListener("click", fn); body.appendChild(b); return b; };
  const mute = document.createElement("label"); mute.className = "settings-row"; mute.innerHTML = "<span></span>"; mute.firstChild.textContent = T("channel.mute");
  const mi = document.createElement("input"); mi.type = "checkbox"; mi.className = "switch"; mi.checked = !!g.muted; mi.addEventListener("change", () => { g.muted = mi.checked; persistContacts(); if (state.tab === "chats") renderChatsList(); }); mute.appendChild(mi); body.appendChild(mute);
  const link = channelInviteLink(g);
  btn(T("channel.copyLink"), () => copyText(link, T("toast.linkCopied")));
  const qr = document.createElement("canvas"); qr.width = 180; qr.height = 180; qr.setAttribute("aria-label", T("channel.qrLabel")); body.appendChild(qr); try { renderQrToCanvas(qr, link); } catch (e) {}
  if (g.ch.owner) {
    const det = document.createElement("details"); const sm = document.createElement("summary"); sm.textContent = T("group.admin.advanced"); det.appendChild(sm); body.appendChild(det);
    const dbtn = (label, fn, cls) => { const b = document.createElement("button"); b.type = "button"; b.className = cls || "btn-secondary"; b.textContent = label; b.addEventListener("click", fn); det.appendChild(b); };
    const fi = document.createElement("input"); fi.type = "file"; fi.accept = "image/*"; fi.className = "hidden"; fi.addEventListener("change", async () => { if (fi.files[0]) { sheet.classList.add("hidden"); await channelPostImage(g, fi.files[0]).catch(() => toast(T("channel.imageTooBig"))); } fi.value = ""; }); det.appendChild(fi);
    dbtn(T("channel.postImage"), () => fi.click());
    if (g.ch.enc) dbtn(T("channel.rotateKey"), async () => { if (!(await confirmSheet(T("channel.rotateConfirm")))) return; await channelRotateKey(g); openChannelInfo(g); });
    dbtn(T("channel.delete"), async () => { if (await confirmSheet(T("channel.deleteConfirm"))) { await channelDelete(g); sheet.classList.add("hidden"); } }, "settings-row destructive");
  } else {
    btn(T("channel.leave"), async () => { if (await confirmSheet(T("channel.leaveConfirm"))) { channelLeave(g); sheet.classList.add("hidden"); } }, "settings-row destructive");
  }
  sheet.classList.remove("hidden");
}
function channelLeave(g) {
  channelSend("channel-unsubscribe", { ch: g.ch.id });
  state.contacts.delete(g.id); delete state.drafts[g.id]; persistDrafts(); persistContacts();
  try { if (typeof __searchIndex !== "undefined" && __searchIndex) __searchIndex.removeChat(g.id); } catch (e) {}
  if (state.chatId === g.id) { state.chatId = null; __lastRenderedChatId = null; renderTab(); } else if (state.tab === "chats") renderChatsList();
}
async function channelDelete(g) {
  const ts = Date.now(), d = await Channels.signDelete(g.ch, ts);
  channelSend("channel-delete", { ch: g.ch.id, ts: d.ts, sig: d.sig }); channelLeave(g);
}
async function channelRotateKey(g) { // новый ключ канала: kv+1, новая мета; старые подписчики новых постов не прочтут, пока не получат новую ссылку
  g.ch.key = btoa(String.fromCharCode.apply(null, crypto.getRandomValues(new Uint8Array(32)))); g.ch.kv = (g.ch.kv | 0) + 1;
  const m = await Channels.signMeta(g.ch, { name: g.name, desc: g.description, enc: true, kv: g.ch.kv, avatar: g.avatar, ts: Math.max(Date.now(), (g.ch.metaTs || 0) + 1) });
  g.ch.metaTs = m.meta.ts; g.ch.metaSig = m.metaSig; persistContacts();
  channelSend("channel-meta", { ch: g.ch.id, meta: m.meta, metaSig: m.metaSig }); toast(T("channel.rotated"));
}
// ---- создание: окно ----
function openNewChannelSheet() {
  let sheet = $("#new-channel-sheet");
  if (!sheet) {
    sheet = document.createElement("div"); sheet.id = "new-channel-sheet"; sheet.className = "sheet hidden"; sheet.setAttribute("role", "dialog"); sheet.setAttribute("aria-modal", "true");
    sheet.innerHTML = '<div class="sheet-backdrop"></div><div class="sheet-panel glass-content"><div class="sheet-handle"></div><h2></h2><input id="new-channel-name" type="text" maxlength="60" class="rename-input" /><textarea id="new-channel-desc" class="rename-input" maxlength="200" rows="2"></textarea><details><summary></summary><label class="settings-row"><span id="new-channel-priv-l"></span><input id="new-channel-priv" type="checkbox" class="switch" /></label><p class="fine muted" id="new-channel-priv-h"></p></details><button type="button" id="new-channel-create" class="btn-primary"></button><button type="button" class="btn-tertiary sheet-cancel"></button></div>';
    document.body.appendChild(sheet);
    const q = (s) => sheet.querySelector(s);
    q("h2").textContent = T("channel.new"); q("#new-channel-name").placeholder = T("channel.name"); q("#new-channel-name").setAttribute("aria-label", T("channel.name")); q("#new-channel-desc").placeholder = T("channel.desc"); q("#new-channel-desc").setAttribute("aria-label", T("channel.desc"));
    q("summary").textContent = T("group.admin.advanced"); q("#new-channel-priv-l").textContent = T("channel.privateToggle"); q("#new-channel-priv-h").textContent = T("channel.privateHint"); q("#new-channel-create").textContent = T("channel.create"); q(".sheet-cancel").textContent = T("sys.close");
    const close = () => sheet.classList.add("hidden");
    q(".sheet-backdrop").addEventListener("click", close); q(".sheet-cancel").addEventListener("click", close);
    q("#new-channel-create").addEventListener("click", async () => { const id = await channelCreate(q("#new-channel-name").value, q("#new-channel-desc").value, q("#new-channel-priv").checked); if (id) { close(); q("#new-channel-name").value = ""; q("#new-channel-desc").value = ""; } });
  }
  const ng = $("#new-group-sheet"); if (ng) ng.classList.add("hidden");
  sheet.classList.remove("hidden"); setTimeout(() => { try { sheet.querySelector("#new-channel-name").focus(); } catch (e) {} }, 30);
}
function channelsWireUi() {
  const b = $("#new-group-btn"); if (!b || $("#new-channel-btn")) return;
  const nb = document.createElement("button"); nb.type = "button"; nb.id = "new-channel-btn"; nb.className = "btn-secondary"; nb.textContent = T("channel.new"); nb.addEventListener("click", openNewChannelSheet);
  b.parentNode.insertBefore(nb, b.nextSibling);
}
