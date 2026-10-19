"use strict";
// Часть 7 из 14 бывшего js/app.js: Отправка/редактирование/удаление, исчезающие. Глобальная область общая; порядок <script> важен.

// =====================================================================
// Отправка/редактирование/удаление
// =====================================================================
async function sendChatMessage(contactId, text, replyTo) {
  const c = state.contacts.get(contactId); if (!c) return false;
  if (c.blocked) { toast(T("toast.blocked")); return false; }
  text = applyEmojiAutoReplace(text);
  if (text.length > MAX_MESSAGE_LENGTH) { text = text.slice(0, MAX_MESSAGE_LENGTH); toast(T("toast.messageCut")); }
  const msgId = crypto.randomUUID();
  const ts = Date.now();
  const rec = { id: msgId, from: "me", text, ts, ack: "sent", serverAcked: false };
  if (replyTo) rec.replyTo = { id: replyTo.msgId, text: replyTo.text, authorName: replyTo.authorName };
  if (c.disappearingTimer) rec.ttl = c.disappearingTimer;
  c.messages.push(rec);
  trimMessages(c);
  c.lastActivity = ts;
  persistContacts();
  if (state.chatId === contactId) {
    renderChatThreadInner();
    const wrap = $("#chat-messages"); if (wrap) wrap.scrollTop = wrap.scrollHeight;
  }
  if (state.tab === "chats") renderChatsList();
  playOutgoingSound();
  haptic("light");
  const payload = { kind: "chat", id: msgId, text, ts };
  if (replyTo) payload.replyTo = { id: replyTo.msgId, text: replyTo.text, authorName: replyTo.authorName };
  if (c.disappearingTimer) payload.ttl = c.disappearingTimer;
  await trySendOrQueue(c, msgId, payload);
  return true; // сообщение записано в чат и поставлено в очередь отправки (для «отправить позже»: запись можно снимать)
}
function trimMessages(c) {
  if (c.messages.length <= MAX_MESSAGES_PER_CHAT) return;
  const dropped = c.messages.slice(0, c.messages.length - MAX_MESSAGES_PER_CHAT);
  c.messages = c.messages.slice(-MAX_MESSAGES_PER_CHAT);
  try { cleanupExpiredFileBlobs(dropped); } catch (e) {} // блобы вложений обрезанной истории не должны висеть в IndexedDB вечно
}
// "Отправить позже" — реально отправляем через тот же sendChatMessage/
// sendGroupMessage, которые использует обычная форма, а не отдельный
// путь доставки: отложенное сообщение технически ничем не отличается от
// обычного, просто момент вызова сдвинут.
// Семантика очереди: запись снимается ТОЛЬКО после того, как сообщение реально записано в чат и поставлено в outbox
// (sendChatMessage/sendGroupMessage вернули true). Блокировка, ограничение «пишут только админы», исключение из группы или
// исключение при отправке оставляют запись в списке со статусом failed — её можно повторить вручную (retryScheduledMessage).
const scheduledInFlight = new Set();
async function sendScheduledOne(s) {
  if (scheduledInFlight.has(s.id)) return;
  scheduledInFlight.add(s.id);
  let ok = false, reason = "";
  try {
    const c = state.contacts.get(s.contactId);
    if (!c) { state.scheduledMessages = state.scheduledMessages.filter((x) => x.id !== s.id); return; } // контакт удалён за время ожидания — молча пропускаем, не ошибка
    if (c.blocked) reason = "blocked";
    else {
      const r = s.isGroup ? await sendGroupMessage(s.contactId, s.text, s.replyTo || null) : await sendChatMessage(s.contactId, s.text, s.replyTo || null);
      ok = r === true;
      if (!ok) reason = s.isGroup ? "group" : "send";
    }
  } catch (e) { reason = "error"; etherLog("error", "[scheduled] send failed:", String(e)); }
  finally { scheduledInFlight.delete(s.id); }
  const cur = state.scheduledMessages.find((x) => x.id === s.id);
  if (ok) state.scheduledMessages = state.scheduledMessages.filter((x) => x.id !== s.id);
  else if (cur) { cur.failed = true; cur.failReason = reason; }
  persistScheduledMessages();
  renderScheduleBanner();
}
function retryScheduledMessage(id) {
  const s = state.scheduledMessages.find((x) => x.id === id); if (!s) return;
  delete s.failed; delete s.failReason; persistScheduledMessages();
  return sendScheduledOne(s);
}
function sweepScheduledMessages() {
  if (!state.scheduledMessages || state.scheduledMessages.length === 0) return;
  const now = Date.now();
  const due = state.scheduledMessages.filter((s) => s.sendAt <= now && !s.failed && !scheduledInFlight.has(s.id));
  if (due.length === 0) return;
  for (const s of due) sendScheduledOne(s);
}
function scheduledCountFor(contactId) {
  return state.scheduledMessages.filter((s) => s.contactId === contactId).length;
}
function renderScheduleBanner() {
  const banner = $("#schedule-banner"); if (!banner) return;
  const n = state.chatId ? scheduledCountFor(state.chatId) : 0;
  banner.classList.toggle("hidden", n === 0);
  const countEl = $("#schedule-banner-count"); if (countEl) countEl.textContent = String(n);
}
function openScheduleSheet() {
  const sheet = $("#schedule-sheet"); if (!sheet) return;
  const input = $("#schedule-custom-input");
  if (input) { const d = new Date(Date.now() + 3600000); d.setSeconds(0, 0); input.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
  sheet.classList.remove("hidden");
}
function queueScheduledMessage(sendAt) {
  if (!state.chatId) return;
  const c = state.contacts.get(state.chatId); if (!c) return;
  const input = $("#chat-input"); if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  const rec = { id: crypto.randomUUID(), contactId: state.chatId, isGroup: isGroup(c), text, replyTo: state.replyTo || null, sendAt };
  state.scheduledMessages.push(rec);
  persistScheduledMessages();
  input.value = "";
  delete state.drafts[state.chatId]; persistDrafts();
  cancelReply();
  updateSendVsMic();
  const sheet = $("#schedule-sheet"); if (sheet) sheet.classList.add("hidden");
  toast(T("toast.scheduled"));
  renderScheduleBanner();
}
function openScheduleListSheet() {
  const list = $("#schedule-list"); if (!list) return;
  list.innerHTML = "";
  const rows = state.scheduledMessages.filter((s) => s.contactId === state.chatId).sort((a, b) => a.sendAt - b.sendAt);
  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "forward-row";
    const snippet = truncate(row.text || "", 60);
    item.innerHTML = `<span class="forward-name">${escapeHtml(snippet)}<br><span class="fine muted">${escapeHtml(formatChatListTime(row.sendAt))}</span>${row.failed ? `<br><span class="fine" role="alert">${escapeHtml(T("schedule.failed"))}</span>` : ""}</span>`;
    if (row.failed) {
      const retryBtn = document.createElement("button");
      retryBtn.type = "button"; retryBtn.className = "btn small schedule-row-retry-btn"; retryBtn.textContent = T("schedule.retry");
      retryBtn.addEventListener("click", async () => { await retryScheduledMessage(row.id); openScheduleListSheet(); });
      item.appendChild(retryBtn);
    }
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button"; cancelBtn.className = "icon-btn small schedule-row-cancel-btn"; cancelBtn.setAttribute("aria-label", T("sys.cancel"));
    cancelBtn.innerHTML = `${Icons.html("x", 18)}`;
    cancelBtn.addEventListener("click", () => {
      state.scheduledMessages = state.scheduledMessages.filter((s) => s.id !== row.id);
      persistScheduledMessages();
      renderScheduleBanner();
      openScheduleListSheet();
    });
    item.appendChild(cancelBtn);
    list.appendChild(item);
  }
  const sheet = $("#schedule-list-sheet"); if (sheet) sheet.classList.remove("hidden");
}
// «Mute for Nh» (из раздела 10 роадмапа, реклассифицировано как опция
// карточки контакта, не кнопка уведомления — нет места в лимите в 2 кнопки
// вместе с «Ответить»/«Прочитано», см. V.38.0.0/V.40.0.0). Шторка открывается
// из #contact-mute-btn только когда контакт ещё НЕ заглушен (см. wireContactCard).
function wireMuteSheet() {
  function apply(muteUntil, forever) {
    const c = state.contacts.get(state.contactCardId); if (!c) return;
    if (forever) { c.muted = true; c.muteUntil = null; }
    else { c.muted = false; c.muteUntil = muteUntil; }
    persistContacts();
    const sheet = $("#mute-sheet"); if (sheet) sheet.classList.add("hidden");
    renderContactCard();
    toast(forever ? T("toast.muted") : T("chat.mute.until", { time: formatChatListTime(muteUntil) }));
  }
  const h1 = $("#mute-preset-1h"); if (h1) h1.addEventListener("click", () => apply(Date.now() + 3600000, false));
  const h8 = $("#mute-preset-8h"); if (h8) h8.addEventListener("click", () => apply(Date.now() + 8 * 3600000, false));
  const tmr = $("#mute-preset-tomorrow"); if (tmr) tmr.addEventListener("click", () => {
    const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0);
    apply(d.getTime(), false);
  });
  const forever = $("#mute-preset-forever"); if (forever) forever.addEventListener("click", () => apply(null, true));
}
function wireScheduleSend() {
  const btn = document.querySelector('#chat-form button[type="submit"].send-btn');
  if (!btn) return;
  let timer = null, fired = false;
  function start() {
    fired = false;
    clearTimeout(timer);
    const input = $("#chat-input");
    if (!input || !input.value.trim() || !state.chatId || state.editingMessageId) return;
    timer = setTimeout(() => {
      fired = true;
      try { if (navigator.vibrate) navigator.vibrate(15); } catch (e) {}
      openScheduleSheet();
    }, 500);
  }
  function cancelTimer() { clearTimeout(timer); }
  btn.addEventListener("touchstart", start, { passive: true });
  btn.addEventListener("touchend", cancelTimer);
  btn.addEventListener("touchmove", cancelTimer);
  btn.addEventListener("touchcancel", cancelTimer);
  btn.addEventListener("mousedown", start);
  btn.addEventListener("mouseup", cancelTimer);
  btn.addEventListener("mouseleave", cancelTimer);
  // Долгое нажатие уже открыло шторку — гасим клик/submit, который иначе
  // отправил бы сообщение немедленно сразу после отпускания.
  btn.addEventListener("click", (e) => { if (fired) { e.preventDefault(); fired = false; } }, true);
  const banner = $("#schedule-banner"); if (banner) banner.addEventListener("click", openScheduleListSheet);
  const preset1h = $("#schedule-preset-1h"); if (preset1h) preset1h.addEventListener("click", () => queueScheduledMessage(Date.now() + 3600000));
  const presetTomorrow = $("#schedule-preset-tomorrow"); if (presetTomorrow) presetTomorrow.addEventListener("click", () => {
    const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0);
    queueScheduledMessage(d.getTime());
  });
  const customBtn = $("#schedule-custom-confirm-btn"); if (customBtn) customBtn.addEventListener("click", () => {
    const input = $("#schedule-custom-input"); if (!input || !input.value) return;
    const ms = new Date(input.value).getTime();
    if (!Number.isFinite(ms)) return;
    queueScheduledMessage(Math.max(ms, Date.now() + 1000));
  });
}
async function commitEdit(contactId, msgId, newText) {
  const c = state.contacts.get(contactId); if (!c) return;
  const m = c.messages.find((x) => x.id === msgId); if (!m) return;
  newText = applyEmojiAutoReplace(String(newText)).slice(0, MAX_MESSAGE_LENGTH);
  const editTs = Date.now();
  m.text = newText; m.edited = true; m.editedAt = editTs; // m.ts не трогаем: у получателя он при правке не меняется
  c.lastActivity = editTs;
  persistContacts();
  if (state.chatId === contactId) renderChatThread();
  const actionId = crypto.randomUUID();
  const payload = { kind: "edit", id: msgId, text: newText, ts: editTs };
  await dispatchRich(c, payload); // личный чат — как раньше; группа — каждому участнику с groupId
}
function deleteMessageLocal(contactId, msgId, batch) {
  const c = state.contacts.get(contactId); if (!c) return;
  const m = c.messages.find((x) => x.id === msgId);
  if (m && (m.file || (m.sticker && m.sticker.custom))) {
    IDB.del("file:" + msgId).catch(() => {});
    const url = fileBlobUrlCache.get(msgId);
    if (url) { URL.revokeObjectURL(url); fileBlobUrlCache.delete(msgId); }
    // удалённое голосовое не должно продолжать играть из кэша аудио-элементов
    const vc = typeof voiceAudioCache !== "undefined" ? voiceAudioCache.get(msgId) : null;
    if (vc) { try { vc.audio.pause(); } catch (e) {} voiceAudioCache.delete(msgId); }
  }
  c.messages = c.messages.filter((x) => x.id !== msgId);
  if (batch) return; // пакетное удаление: сохранение и перерисовка — один раз после цикла
  persistContacts();
  if (state.chatId === contactId) renderChatThread();
  if (state.tab === "chats") renderChatsList();
}
async function deleteMessageForBoth(contactId, msgId) {
  const c = state.contacts.get(contactId); if (!c) return;
  deleteMessageLocal(contactId, msgId);
  const actionId = crypto.randomUUID();
  const payload = { kind: "delete", id: msgId, ts: Date.now() };
  await dispatchRich(c, payload);
}
// Пересылка контакта другому контакту — карточка со своим видом в
// пузыре сообщения (имя + кнопка "Добавить"), не обычный текст.
// ===== Истории: короткая история на 24 часа (текст или фото с подписью) для всех контактов (сквозное шифрование — тот же канал, что у сообщений) =====
const STORY_TTL_MS = 24 * 3600e3, STORY_MAX_LEN = 280, STORY_BG_COUNT = 6;
const STORY_PHOTO_MAX_DIM = 1080;            // длинная сторона отправляемого фото
const STORY_PHOTO_TARGET_BYTES = 400 * 1024; // к этому размеру сжимаем при публикации
const STORY_PHOTO_MAX_BYTES = 512 * 1024;    // жёсткий потолок при приёме (с запасом над целью)
const STORY_PHOTO_MAX_SIDE = 4096;           // заявленные размеры сверх этого — мусор
const STORY_PER_OWNER_MAX = 20, STORY_PHOTO_MIMES = ["image/jpeg", "image/png", "image/webp"];
let storiesList = null; // [{ id, owner ("me" или id контакта), text, bg, ts, seen, photo?: { mime, w, h, size } }]
// Ключ IndexedDB с данными фото: свои — "file:<id>" (по нему же очередь отправки достаёт файл), чужие — в отдельном пространстве
// "file:story:<от кого>:<id>", чтобы присланный id не мог затереть чужое вложение. Префикс "file:" — значит, под PIN-шифрование попадает так же, как вложения.
function storyPhotoKey(st) { return st.owner === "me" ? "file:" + st.id : "file:story:" + st.owner + ":" + st.id; }
const storyPhotoUrls = new Map(); // id истории -> object URL (отзывается при удалении/истечении)
function dropStoryPhotos(list) {
  for (const st of list) {
    if (!st || !st.photo) continue;
    const u = storyPhotoUrls.get(st.id); if (u) { try { URL.revokeObjectURL(u); } catch (e) {} storyPhotoUrls.delete(st.id); }
    try { Promise.resolve(IDB.del(storyPhotoKey(st))).catch(() => {}); } catch (e) {}
  }
}
function sanitizeStoryPhotoMeta(p) {
  if (!p || typeof p !== "object" || !STORY_PHOTO_MIMES.includes(p.mime)) return null;
  const dim = (v) => (Number.isInteger(v) && v > 0 && v <= STORY_PHOTO_MAX_SIDE ? v : 0);
  const size = Number.isInteger(p.size) && p.size > 0 && p.size <= STORY_PHOTO_MAX_BYTES ? p.size : 0;
  return { mime: p.mime, w: dim(p.w), h: dim(p.h), size };
}
function loadStories() {
  if (storiesList) return storiesList;
  try {
    storiesList = (JSON.parse(Store.storiesJson) || []).filter((x) => x && typeof x.id === "string" && typeof x.text === "string" && Number.isFinite(x.ts))
      .map((x) => { if (x.photo) { x.photo = sanitizeStoryPhotoMeta(x.photo); if (!x.photo && !x.text) return null; } return x; }).filter(Boolean);
  } catch (e) { storiesList = []; }
  return storiesList;
}
function pruneStories() {
  const list = loadStories(), now = Date.now(), n = list.length;
  const keep = [], gone = [];
  for (const x of list) (now - x.ts < STORY_TTL_MS && x.ts <= now + 60000 ? keep : gone).push(x);
  storiesList = keep;
  if (gone.length) { dropStoryPhotos(gone); persistStories(); }
  return storiesList;
}
function persistStories() {
  try {
    const all = loadStories();
    if (all.length > 300) { const cut = all.splice(0, all.length - 300); dropStoryPhotos(cut); }
    Store.storiesJson = JSON.stringify(all);
  } catch (e) { handlePersistError(e, "stories"); }
}
// Проверка присланных байтов по сигнатуре: заявленный mime должен совпадать с реальным форматом файла
function storyPhotoBytesOk(bytes, mime) {
  if (!bytes || bytes.length < 12 || bytes.length > STORY_PHOTO_MAX_BYTES) return false;
  if (mime === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "image/png") return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  if (mime === "image/webp") return bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  return false;
}
// Фото из галереи/камеры → JPEG до 1080 px по длинной стороне и ≈400 КБ (заодно пропадают EXIF и геометки).
// Слишком вытянутые кадры обрезаются по центру до 2:1. Возвращает { blob, w, h } или null.
async function prepareStoryPhoto(file) {
  if (!file || fileKindFromMime(file.type) !== "image" || !(file.size > 0) || file.size > MAX_FILE_SIZE_INPUT) return null;
  let bmp;
  try { bmp = await createImageBitmap(file); } catch (e) { return null; }
  try {
    const w = bmp.width, h = bmp.height; if (!(w > 0 && h > 0)) return null;
    let sx = 0, sy = 0, sw = w, sh = h;
    if (h / w > 2) { sh = Math.round(w * 2); sy = Math.round((h - sh) / 2); } else if (w / h > 2) { sw = Math.round(h * 2); sx = Math.round((w - sw) / 2); }
    let scale = Math.min(1, STORY_PHOTO_MAX_DIM / Math.max(sw, sh));
    for (let attempt = 0; attempt < 4; attempt++) {
      const dw = Math.max(1, Math.round(sw * scale)), dh = Math.max(1, Math.round(sh * scale));
      const canvas = document.createElement("canvas"); canvas.width = dw; canvas.height = dh;
      const ctx = canvas.getContext("2d"); if (!ctx) return null;
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, dw, dh);
      ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, dw, dh);
      for (const q of [0.82, 0.68, 0.5]) {
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", q));
        if (blob && blob.size > 0 && blob.size <= STORY_PHOTO_TARGET_BYTES) return { blob, w: dw, h: dh };
      }
      scale *= 0.75;
    }
    return null;
  } finally { try { bmp.close && bmp.close(); } catch (e) {} }
}
async function publishStory(text, bg, photo) {
  text = String(text || "").trim().slice(0, STORY_MAX_LEN);
  if (photo && !(photo.blob && photo.blob.size > 0 && photo.blob.size <= STORY_PHOTO_MAX_BYTES && photo.blob.type === "image/jpeg")) photo = null;
  if (!text && !photo) return false;
  bg = Math.max(0, Math.min(STORY_BG_COUNT - 1, bg | 0));
  const id = crypto.randomUUID(), ts = Date.now();
  let b64 = "";
  const rec = { id, owner: "me", text, bg, ts, seen: true };
  if (photo) {
    try {
      const buf = await photo.blob.arrayBuffer();
      if (!storyPhotoBytesOk(new Uint8Array(buf), "image/jpeg")) return false;
      b64 = arrayBufferToBase64(buf);
      await IDB.set("file:" + id, new Blob([buf], { type: "image/jpeg" }));
    } catch (e) { toast(T("stories.photo.bad")); return false; }
    const w = Number.isInteger(photo.w) && photo.w > 0 && photo.w <= STORY_PHOTO_MAX_SIDE ? photo.w : 0, h = Number.isInteger(photo.h) && photo.h > 0 && photo.h <= STORY_PHOTO_MAX_SIDE ? photo.h : 0;
    rec.photo = { mime: "image/jpeg", w, h, size: photo.blob.size };
  }
  loadStories().push(rec); persistStories();
  const targets = Array.from(state.contacts.values()).filter((c) => c.managed && !c.isGroup && !c.isSelf && !c.blocked && c.publicKey); // без ключа не шлём: иначе тост «ждём ключ» на каждого
  for (const c of targets) {
    const payload = { kind: "story", id, text, bg, ts };
    if (photo) { payload.mime = "image/jpeg"; payload.w = rec.photo.w; payload.h = rec.photo.h; payload.dataB64 = b64; }
    await trySendOrQueue(c, crypto.randomUUID(), payload);
  }
  renderStoriesRow();
  return true;
}
const storyReceiving = new Set(); // id историй с фото, которые сейчас записываются (защита от дублей при гонке)
// Всё входящее — недоверенные данные: id, подпись, mime, размер, сигнатура файла и количество проверяются здесь
function receiveStory(from, payload) {
  const c = state.contacts.get(from); if (!c || c.blocked || c.isGroup) return;
  if (!payload || typeof payload.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(payload.id)) return;
  const text = typeof payload.text === "string" ? payload.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, STORY_MAX_LEN) : "";
  const hasPhoto = payload.dataB64 !== undefined || payload.mime !== undefined;
  if (!text && !hasPhoto) return;
  const ts = Math.min(Number(payload.ts) || Date.now(), Date.now());
  if (!Number.isFinite(ts) || Date.now() - ts >= STORY_TTL_MS) return;
  const list = loadStories(); if (list.some((x) => x.id === payload.id && x.owner === from) || storyReceiving.has(from + ":" + payload.id)) return;
  if (list.some((x) => x.id === payload.id)) return; // чужой id уже занят (в том числе нашей историей)
  const bg = Math.max(0, Math.min(STORY_BG_COUNT - 1, payload.bg | 0));
  const commit = (photo, blob) => {
    const cur = loadStories(); if (cur.some((x) => x.id === payload.id)) return;
    const mine = cur.filter((x) => x.owner === from);
    if (mine.length >= STORY_PER_OWNER_MAX) { const old = mine.sort((a, b) => a.ts - b.ts).slice(0, mine.length - STORY_PER_OWNER_MAX + 1); storiesList = cur.filter((x) => !old.includes(x)); dropStoryPhotos(old); }
    const rec = { id: payload.id, owner: from, text, bg, ts, seen: false };
    if (photo) rec.photo = photo;
    loadStories().push(rec); persistStories();
    if (state.tab === "chats" && !state.chatId) renderStoriesRow();
  };
  if (!hasPhoto) { commit(null); return; }
  // Фото: строгая проверка. Только растровые mime (jpeg/png/webp, см. fileKindFromMime), размер, base64 и сигнатура.
  const mime = typeof payload.mime === "string" ? payload.mime.toLowerCase() : "";
  if (!STORY_PHOTO_MIMES.includes(mime) || fileKindFromMime(mime) !== "image") return;
  const b64 = payload.dataB64;
  if (typeof b64 !== "string" || b64.length < 16 || b64.length > Math.ceil(STORY_PHOTO_MAX_BYTES * 4 / 3) + 8 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return;
  let bytes; try { bytes = base64ToUint8Array(b64); } catch (e) { return; }
  if (!storyPhotoBytesOk(bytes, mime)) return;
  const dim = (v) => (Number.isInteger(v) && v > 0 && v <= STORY_PHOTO_MAX_SIDE ? v : 0);
  const photo = { mime, w: dim(payload.w), h: dim(payload.h), size: bytes.length };
  const key = from + ":" + payload.id; storyReceiving.add(key);
  const blob = new Blob([bytes], { type: mime });
  Promise.resolve(IDB.set("file:story:" + from + ":" + payload.id, blob))
    .then(() => { commit(photo, blob); })
    .catch((e) => { etherLog("warn", "[story] photo not stored:", String(e)); })
    .finally(() => storyReceiving.delete(key));
}
function renderStoriesRow() {
  const row = $("#stories-row"); if (!row) return;
  const list = pruneStories();
  const owners = [];
  for (const st of list) if (st.owner !== "me" && !owners.includes(st.owner) && state.contacts.has(st.owner) && !state.contacts.get(st.owner).blocked) owners.push(st.owner);
  const hasMine = list.some((x) => x.owner === "me");
  if (!owners.length && !hasMine && !Array.from(state.contacts.values()).some((c) => c.managed && !c.isSelf && !c.isGroup)) { row.classList.add("hidden"); row.innerHTML = ""; return; }
  row.classList.remove("hidden");
  const bubble = (id, name, ring, inner, label) => `<button type="button" class="story-item${ring}" data-story-owner="${escapeHtml(id)}" aria-label="${escapeHtml(label)}"><span class="story-ring">${inner}</span><span class="story-name">${escapeHtml(name)}</span></button>`;
  const mineLast = list.filter((x) => x.owner === "me").sort((a, b) => b.ts - a.ts)[0];
  const mineInner = mineLast ? `<span class="story-thumb story-bg-${mineLast.bg | 0}"${mineLast.photo ? ` data-story-photo="${escapeHtml(mineLast.id)}"` : ""}>${mineLast.photo && !mineLast.text ? Icons.html("camera", 18) : escapeHtml(String(mineLast.text || "").slice(0, 18))}</span>` : `<span class="story-plus">${Icons.html("plus", 20)}</span>`;
  let html = bubble("__new__", hasMine ? T("stories.mine") : T("stories.add"), hasMine ? " is-mine" : " is-add", mineInner, hasMine ? T("stories.mine") : T("stories.add"));
  if (hasMine) html = html.replace("</button>", `<span class="story-add-badge" data-story-add="1" role="button" aria-label="${escapeHtml(T("stories.add"))}">${Icons.html("plus", 12)}</span></button>`);
  for (const id of owners) {
    const c = state.contacts.get(id), unseen = list.some((x) => x.owner === id && !x.seen);
    html += bubble(id, c.name || T("sys.someone"), unseen ? " is-unseen" : "", avatarCircleHtml(c, null, ""), T("stories.of", { name: c.name || "" }));
  }
  row.innerHTML = html;
  row.querySelectorAll(".story-item").forEach((b) => b.addEventListener("click", (e) => {
    const owner = b.getAttribute("data-story-owner");
    if (e.target.closest && e.target.closest("[data-story-add]")) { openStoryComposer(); return; }
    if (owner === "__new__") { if (hasMine && list.some((x) => x.owner === "me")) openStoryViewer("me"); else openStoryComposer(); }
    else openStoryViewer(owner);
  }));
  const th = row.querySelector("[data-story-photo]");
  if (th && mineLast && mineLast.photo) getStoryPhotoUrl(mineLast).then((u) => { if (u && th.isConnected) { th.style.backgroundImage = `url('${u}')`; th.style.backgroundSize = "cover"; th.style.backgroundPosition = "center"; } });
}
// Object URL фото истории из IndexedDB (кэш на время жизни истории); null, если данных нет
async function getStoryPhotoUrl(st) {
  if (!st || !st.photo) return null;
  const cached = storyPhotoUrls.get(st.id); if (cached) return cached;
  let blob = null; try { blob = await IDB.get(storyPhotoKey(st)); } catch (e) {}
  if (!blob || typeof blob.size !== "number" || !STORY_PHOTO_MIMES.includes(st.photo.mime)) return null;
  const url = URL.createObjectURL(blob.type === st.photo.mime ? blob : new Blob([blob], { type: st.photo.mime }));
  storyPhotoUrls.set(st.id, url);
  return url;
}
let __storyViewer = null;
function openStoryViewer(owner) {
  const items = pruneStories().filter((x) => x.owner === owner).sort((a, b) => a.ts - b.ts);
  const ov = $("#story-viewer"); if (!ov || !items.length) { if (owner === "me") openStoryComposer(); return; }
  __storyViewer = { owner, items, i: Math.max(0, items.findIndex((x) => !x.seen)) , timer: null };
  ov.classList.remove("hidden"); showStory();
  setTimeout(() => { try { const b = $("#story-close-btn"); if (b && __storyViewer) b.focus(); } catch (e) {} }, 30);
}
function showStory() {
  const v = __storyViewer, ov = $("#story-viewer"); if (!v || !ov) return;
  clearTimeout(v.timer);
  if (v.i >= v.items.length) { closeStoryViewer(); return; }
  const st = v.items[v.i]; st.seen = true; persistStories();
  const c = state.contacts.get(st.owner);
  ov.className = "story-viewer story-bg-" + (st.photo ? 4 : st.bg) + (st.photo ? " has-photo" : "");
  const img = $("#story-photo");
  if (img) {
    img.classList.add("hidden"); img.removeAttribute("src"); img.alt = "";
    if (st.photo) {
      getStoryPhotoUrl(st).then((u) => {
        const cur = __storyViewer && __storyViewer.items[__storyViewer.i];
        if (!cur || cur.id !== st.id) return; // успели перелистнуть
        if (u) { img.src = u; img.alt = st.text || T("stories.photo.alt"); img.classList.remove("hidden"); }
        else { $("#story-text").textContent = st.text ? st.text + " · " + T("chat.file.unavailable") : T("chat.file.unavailable"); }
      });
    }
  }
  $("#story-text").textContent = st.text; // textContent: подпись никогда не разбирается как HTML
  $("#story-who").textContent = st.owner === "me" ? T("stories.mine") : ((c && c.name) || T("sys.someone"));
  $("#story-time").textContent = formatTime(st.ts);
  $("#story-bars").innerHTML = v.items.map((_, k) => `<span class="${k < v.i ? "done" : k === v.i ? "cur" : ""}"></span>`).join("");
  $("#story-delete-btn").classList.toggle("hidden", st.owner !== "me");
  const rf = $("#story-reply"); if (rf) { rf.classList.toggle("hidden", st.owner === "me" || !c || !c.managed); const ri = $("#story-reply-input"); if (ri && !ri.value) ri.blur(); }
  v.timer = setTimeout(() => { v.i++; showStory(); }, 6000);
}
function closeStoryViewer() {
  if (__storyViewer) clearTimeout(__storyViewer.timer); __storyViewer = null;
  const ov = $("#story-viewer"); if (ov) ov.classList.add("hidden");
  const img = $("#story-photo"); if (img) { img.removeAttribute("src"); img.classList.add("hidden"); }
  renderStoriesRow();
}
let __storyDraftPhoto = null; // { blob, w, h, url } — выбранное, ещё не опубликованное фото
function setStoryDraftPhoto(p) {
  if (__storyDraftPhoto && __storyDraftPhoto.url) { try { URL.revokeObjectURL(__storyDraftPhoto.url); } catch (e) {} }
  __storyDraftPhoto = p ? { blob: p.blob, w: p.w, h: p.h, url: URL.createObjectURL(p.blob) } : null;
  const box = $("#story-photo-preview"), img = $("#story-photo-preview-img"), inp = $("#story-input");
  if (box) box.classList.toggle("hidden", !__storyDraftPhoto);
  if (img) { img.alt = T("stories.photo.alt"); if (__storyDraftPhoto) img.src = __storyDraftPhoto.url; else img.removeAttribute("src"); }
  if (inp) inp.placeholder = T(__storyDraftPhoto ? "stories.caption.placeholder" : "stories.placeholder");
}
function openStoryComposer() {
  const sheet = $("#story-sheet"); if (!sheet) return;
  $("#story-input").value = ""; sheet.dataset.bg = "0"; setStoryDraftPhoto(null);
  $$("#story-swatches .story-swatch").forEach((b, i) => b.classList.toggle("on", i === 0));
  sheet.classList.remove("hidden"); setTimeout(() => { try { $("#story-input").focus(); } catch (e) {} }, 60);
}
async function pickStoryPhoto(file) {
  if (!file) return;
  const sheet = $("#story-sheet"); if (sheet) sheet.setAttribute("aria-busy", "true");
  try {
    const p = await prepareStoryPhoto(file);
    if (!p) { toast(T("stories.photo.bad")); return; }
    setStoryDraftPhoto(p);
  } finally { if (sheet) sheet.removeAttribute("aria-busy"); }
}
function wireStories() {
  const sw = $("#story-swatches");
  if (sw && !sw.children.length) {
    for (let i = 0; i < STORY_BG_COUNT; i++) { const b = document.createElement("button"); b.type = "button"; b.className = "story-swatch story-bg-" + i + (i === 0 ? " on" : ""); b.setAttribute("aria-label", "#" + (i + 1)); b.addEventListener("click", () => { $("#story-sheet").dataset.bg = String(i); $$("#story-swatches .story-swatch").forEach((x, k) => x.classList.toggle("on", k === i)); }); sw.appendChild(b); }
  }
  const pub = $("#story-publish-btn");
  if (pub) pub.addEventListener("click", async () => {
    if (pub.disabled) return; pub.disabled = true;
    try { if (await publishStory($("#story-input").value, parseInt($("#story-sheet").dataset.bg, 10) || 0, __storyDraftPhoto)) { $("#story-sheet").classList.add("hidden"); setStoryDraftPhoto(null); } }
    finally { pub.disabled = false; }
  });
  const pickBtn = $("#story-photo-pick"), camBtn = $("#story-photo-camera"), pickIn = $("#story-photo-input"), camIn = $("#story-camera-input"), rmBtn = $("#story-photo-remove");
  if (pickBtn && pickIn) pickBtn.addEventListener("click", () => pickIn.click());
  if (camBtn && camIn) camBtn.addEventListener("click", () => camIn.click());
  for (const inp of [pickIn, camIn]) if (inp) inp.addEventListener("change", () => { const f = inp.files && inp.files[0]; inp.value = ""; pickStoryPhoto(f); });
  if (rmBtn) rmBtn.addEventListener("click", () => setStoryDraftPhoto(null));
  const ov = $("#story-viewer");
  if (ov) {
    ov.addEventListener("click", (e) => { if (e.target.closest("#story-close-btn") || e.target.closest("#story-delete-btn")) return; if (__storyViewer) { __storyViewer.i++; showStory(); } });
    $("#story-close-btn").addEventListener("click", (e) => { e.stopPropagation(); closeStoryViewer(); });
    const rf = $("#story-reply"), ri = $("#story-reply-input");
    if (rf && ri) {
      rf.addEventListener("click", (e) => e.stopPropagation());
      ri.addEventListener("focus", () => { if (__storyViewer) clearTimeout(__storyViewer.timer); });
      rf.addEventListener("submit", async (e) => {
        e.preventDefault(); const v = __storyViewer, text = ri.value.trim(); if (!v || !text) return;
        const st = v.items[v.i], c = state.contacts.get(st.owner); if (!c) return;
        ri.value = ""; ri.blur(); closeStoryViewer();
        await sendChatMessage(c.id, text, { msgId: "story:" + st.id, text: "📖 " + (st.text || T("stories.photo.alt")).slice(0, 80), authorName: c.name });
        toast(T("stories.replySent"));
      });
    }
    $("#story-delete-btn").addEventListener("click", (e) => {
      e.stopPropagation(); const v = __storyViewer; if (!v) return;
      const st = v.items[v.i]; storiesList = loadStories().filter((x) => x.id !== st.id); dropStoryPhotos([st]); persistStories(); closeStoryViewer();
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && __storyViewer) closeStoryViewer(); });
  }
}
// ===== Треды: ветка ответов на сообщение (поверх обычных ответов replyTo) =====
function threadMessages(c, rootId) {
  const root = c.messages.find((m) => m.id === rootId); if (!root) return null;
  const out = [root], seen = new Set([rootId]);
  for (let i = 0; i < out.length; i++) {
    for (const m of c.messages) {
      const rid = m.replyTo && (m.replyTo.id || m.replyTo.msgId);
      if (rid === out[i].id && !seen.has(m.id)) { seen.add(m.id); out.push(m); }
    }
  }
  return out;
}
function openThread(contactId, rootId) {
  const c = state.contacts.get(contactId); if (!c || !threadMessages(c, rootId)) return;
  state.threadRoot = { cid: contactId, rootId };
  const sheet = $("#thread-sheet"); if (!sheet) return;
  renderThreadSheet(); sheet.classList.remove("hidden");
}
function closeThreadSheet() { state.threadRoot = null; const sheet = $("#thread-sheet"); if (sheet) sheet.classList.add("hidden"); }
function renderThreadSheet() {
  const tr = state.threadRoot, list = $("#thread-list"); if (!tr || !list) return;
  const c = state.contacts.get(tr.cid), msgs = c && threadMessages(c, tr.rootId);
  if (!msgs) { closeThreadSheet(); return; }
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  const item = (m, i) => {
    const who = m.from === "me" ? T("chat.poll.you") : (m.fromName || c.name || T("sys.someone"));
    const text = m.text ? escapeHtml(m.text) : escapeHtml(T("chat.thread.attachment"));
    return `<div class="thread-msg${i === 0 ? " is-root" : ""}${m.from === "me" ? " mine" : ""}" data-thread-msg="${escapeHtml(m.id)}"><div class="thread-msg-h"><b>${escapeHtml(who)}</b><span>${escapeHtml(formatTime(m.ts))}</span></div><div class="thread-msg-t">${text}</div></div>`;
  };
  const n = msgs.length - 1;
  const rootEl = $("#thread-root");
  if (rootEl) rootEl.innerHTML = `<div class="thread-root-label">${escapeHtml(T("chat.thread.original"))}</div>${item(msgs[0], 0)}`;
  list.innerHTML = n ? msgs.slice(1).map((m, i) => item(m, i + 1)).join("") : `<p class="thread-none">${escapeHtml(T("chat.thread.none"))}</p>`;
  const title = $("#thread-sheet-title"); if (title) title.textContent = T("chat.thread.title") + (n ? " · " + n : "");
  // писать в тред нельзя там, где нельзя писать в чат (заблокированный контакт, группа «пишут только админы»)
  const canWrite = !(c.blocked && !isGroup(c)) && !(isGroup(c) && typeof isGroupWriteAllowed === "function" && !isGroupWriteAllowed(c, Store.myId));
  const inp = $("#thread-input"), btn = $("#thread-send-btn"); if (inp) inp.disabled = !canWrite; if (btn) btn.disabled = !canWrite;
  if (atBottom || list.dataset.fresh !== tr.rootId) { list.scrollTop = list.scrollHeight; list.dataset.fresh = tr.rootId; }
}
function sendThreadReply() {
  const tr = state.threadRoot, input = $("#thread-input"); if (!tr || !input) return;
  const text = input.value.trim(); if (!text) return;
  const c = state.contacts.get(tr.cid), root = c && c.messages.find((m) => m.id === tr.rootId); if (!root) return;
  input.value = "";
  const rt = { msgId: root.id, text: root.text || T("chat.thread.attachment"), authorName: root.from === "me" ? (Store.name || "") : (root.fromName || c.name || "") };
  if (isGroup(c)) sendGroupMessage(c.id, text, rt); else sendChatMessage(c.id, text, rt);
}
function wireThreadSheet() {
  const btn = $("#thread-send-btn"); if (btn) btn.addEventListener("click", sendThreadReply);
  const inp = $("#thread-input"); if (inp) inp.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendThreadReply(); } });
  const close = $("#thread-close-btn"); if (close) close.addEventListener("click", closeThreadSheet);
  // свайп вниз за шапку закрывает шторку (на широком экране панель боковая — там только крестик и Esc)
  const head = $(".thread-head");
  if (head) {
    let y0 = null;
    head.addEventListener("touchstart", (e) => { y0 = e.touches[0].clientY; }, { passive: true });
    head.addEventListener("touchend", (e) => { const t = e.changedTouches[0]; if (y0 !== null && t && t.clientY - y0 > 60) closeThreadSheet(); y0 = null; });
  }
  const sheet = $("#thread-sheet");
  if (sheet && typeof MutationObserver !== "undefined") new MutationObserver(() => { if (sheet.classList.contains("hidden")) state.threadRoot = null; }).observe(sheet, { attributes: true, attributeFilter: ["class"] });
}
// ===== Опросы и доски (логика — js/rich.js) =====
async function dispatchRich(c, payload, ackMsgId) {
  if (c.isSelf) { if (c.isDemo) demoOnSend(c, payload); return; }
  if (isGroup(c)) {
    payload.groupId = c.id; payload.senderName = Store.name || T("sys.someone");
    for (const mem of c.members) {
      if (mem.id === Store.myId) continue;
      const mc = ensureContactEntry(mem.id, mem.name);
      const deliveryId = crypto.randomUUID();
      if (ackMsgId) { groupDeliveryMap.set(deliveryId, { groupId: c.id, contentId: ackMsgId, to: mem.id }); trimMap(groupDeliveryMap, GROUP_DELIVERY_MAP_LIMIT); persistGroupDeliveryMap(); }
      await trySendOrQueue(mc, deliveryId, Object.assign({}, payload));
    }
  } else {
    await trySendOrQueue(c, ackMsgId || crypto.randomUUID(), payload);
  }
}
function pushRichMessage(c, rec) {
  if (c.disappearingTimer) rec.ttl = c.disappearingTimer;
  c.messages.push(rec); trimMessages(c); c.lastActivity = rec.ts; persistContacts();
  if (state.chatId === c.id) { renderChatThreadInner(); const wrap = $("#chat-messages"); if (wrap) wrap.scrollTop = wrap.scrollHeight; }
  if (state.tab === "chats") renderChatsList();
  playOutgoingSound(); haptic("light");
}
async function createPoll(contactId, q, optTexts, multi, extra) {
  const c = state.contacts.get(contactId); if (!c) return false;
  if (c.blocked) { toast(T("toast.blocked")); return false; }
  if (isGroup(c) && !isGroupWriteAllowed(c, Store.myId)) { toast(T("toast.groupWriteRestricted")); return false; }
  const poll = EtherRich.sanitizePoll({ q, multi, pub: extra && extra.pub, closeAt: extra && extra.closeAt, opts: optTexts.map((t, i) => ({ id: "o" + (i + 1), t })) });
  if (!poll) { toast(T("chat.poll.needTwo")); return false; }
  const msgId = crypto.randomUUID(), ts = Date.now();
  const rec = { id: msgId, from: "me", text: poll.q, ts, ack: "sent", serverAcked: false, poll, pollVotes: {} };
  pushRichMessage(c, rec);
  const payload = { kind: "poll", id: msgId, ts, poll: { q: poll.q, multi: poll.multi, opts: poll.opts, pub: poll.pub, closeAt: poll.closeAt } };
  if (rec.ttl) payload.ttl = rec.ttl;
  await dispatchRich(c, payload, msgId);
  return true;
}
async function votePoll(contactId, msgId, optId) {
  const c = state.contacts.get(contactId); const m = c && c.messages.find((x) => x.id === msgId); if (!m || !m.poll || EtherRich.isClosed(m)) return;
  const cur = (m.pollVotes && m.pollVotes[Store.myId]) || [];
  let next;
  if (m.poll.multi) next = cur.includes(optId) ? cur.filter((x) => x !== optId) : cur.concat(optId);
  else next = cur[0] === optId ? [] : [optId];
  if (!EtherRich.applyVote(m, Store.myId, next)) return;
  haptic("light"); persistContacts();
  if (state.chatId === contactId) renderChatThread();
  await dispatchRich(c, { kind: "poll-vote", id: msgId, opts: next, ts: Date.now() });
}
async function closePollMsg(contactId, msgId) {
  const c = state.contacts.get(contactId); const m = c && c.messages.find((x) => x.id === msgId);
  if (!m || m.from !== "me" || !EtherRich.closePoll(m)) return;
  persistContacts(); if (state.chatId === contactId) renderChatThread();
  await dispatchRich(c, { kind: "poll-close", id: msgId, ts: Date.now() });
}
async function createBoard(contactId, title, colKeys) {
  const c = state.contacts.get(contactId); if (!c) return false;
  if (c.blocked) { toast(T("toast.blocked")); return false; }
  if (isGroup(c) && !isGroupWriteAllowed(c, Store.myId)) { toast(T("toast.groupWriteRestricted")); return false; }
  const board = EtherRich.sanitizeBoard({ title: title || T("chat.board.defaultTitle"), cols: (colKeys || ["todo", "doing", "done"]).map((id) => ({ id, t: T("chat.board.col" + ({ todo: 1, doing: 2, done: 3 })[id]) })) });
  if (!board) return false;
  const msgId = crypto.randomUUID(), ts = Date.now();
  const rec = { id: msgId, from: "me", text: board.title, ts, ack: "sent", serverAcked: false, board };
  pushRichMessage(c, rec);
  const payload = { kind: "board", id: msgId, ts, board: { title: board.title, cols: board.cols } };
  if (rec.ttl) payload.ttl = rec.ttl; // таймер исчезновения должен действовать и у получателя
  await dispatchRich(c, payload, msgId);
  return true;
}
async function createNote(contactId, title) {
  const c = state.contacts.get(contactId); if (!c) return false;
  if (c.blocked) { toast(T("toast.blocked")); return false; }
  if (isGroup(c) && !isGroupWriteAllowed(c, Store.myId)) { toast(T("toast.groupWriteRestricted")); return false; }
  const note = EtherRich.sanitizeNote({ title: title || T("chat.note.defaultTitle"), text: "" });
  const msgId = crypto.randomUUID(), ts = Date.now();
  const rec = { id: msgId, from: "me", text: note.title, ts, ack: "sent", serverAcked: false, note };
  pushRichMessage(c, rec);
  const payload = { kind: "note", id: msgId, ts, note: { title: note.title, text: "" } };
  if (rec.ttl) payload.ttl = rec.ttl;
  await dispatchRich(c, payload, msgId);
  return true;
}
async function noteOp(contactId, msgId, text) {
  const c = state.contacts.get(contactId); const m = c && c.messages.find((x) => x.id === msgId); if (!m || !m.note) return;
  const ts = Date.now();
  if (!EtherRich.applyNoteOp(m, { t: "set", text }, ts)) return;
  persistContacts(); if (state.chatId === contactId) renderChatThread();
  await dispatchRich(c, { kind: "note-op", id: msgId, op: { t: "set", text: m.note.text }, ts });
}
async function boardOp(contactId, msgId, op) {
  const c = state.contacts.get(contactId); const m = c && c.messages.find((x) => x.id === msgId); if (!m || !m.board) return;
  const ts = Date.now();
  if (!EtherRich.applyBoardOp(m, op, ts)) return;
  haptic("light"); persistContacts();
  if (state.chatId === contactId) renderChatThread();
  await dispatchRich(c, { kind: "board-op", id: msgId, op, ts });
}
// Входящие: создание и операции. Контейнер — группа (payload.groupId, отправитель должен быть участником) или личный чат.
function richContainer(from, payload, create) {
  if (payload && payload.groupId) {
    const g = state.contacts.get(payload.groupId);
    if (!g || !g.isGroup || !g.members.some((x) => x.id === from)) return null;
    return g;
  }
  return create ? ensureContactEntry(from, null) : state.contacts.get(from);
}
function applyIncomingRich(from, envelopeMsgId, payload) {
  const kind = payload.kind;
  const create = kind === "poll" || kind === "board" || kind === "note";
  const c = richContainer(from, payload, create); if (!c) return;
  if (create) {
    if (c.messages.some((x) => x.id === payload.id) || typeof payload.id !== "string") return;
    if (payload.groupId && c.writeRestricted && !isGroupAdmin(c, from)) return;
    const rec = { id: payload.id, from: "them", text: "", ts: safeMsgTs(payload.ts), readAckSent: false, deliveryId: envelopeMsgId };
    if (payload.groupId) { rec.fromId = from; rec.fromName = (typeof payload.senderName === "string" && payload.senderName.slice(0, 40)) || (state.contacts.get(from) && state.contacts.get(from).name) || T("sys.someone"); }
    if (kind === "poll") { const poll = EtherRich.sanitizePoll(payload.poll); if (!poll) return; rec.poll = poll; rec.pollVotes = {}; rec.text = poll.q; }
    else if (kind === "note") { const note = EtherRich.sanitizeNote(payload.note); if (!note) return; rec.note = note; rec.text = note.title; if (payload.note && payload.note.text) { EtherRich.applyNoteOp(rec, { t: "set", text: payload.note.text }, rec.ts); } }
    else { const board = EtherRich.sanitizeBoard(payload.board); if (!board) return; rec.board = board; rec.text = board.title; }
    if (safeTtl(payload.ttl)) rec.ttl = safeTtl(payload.ttl);
    c.messages.push(rec); trimMessages(c); c.lastActivity = Date.now(); persistContacts();
    const routeId = c.id;
    const preview = T(kind === "poll" ? "chat.poll.preview" : kind === "note" ? "chat.note.preview" : "chat.board.preview", kind === "poll" ? { q: rec.text } : { title: rec.text });
    if (state.chatId === routeId) { renderChatThread(); playMessageSound(routeId); vibrate([80, 40, 80]); announceToScreenReader(T("sr.newMessage", { name: rec.fromName || c.name, text: truncate(preview, 80) })); }
    else {
      toast(`${c.name}: ${truncate(preview, 40)}`);
      if (!isContactMuted(c)) showNotification(c.name || T("app.name"), truncate(preview, 80), { tag: "ether-msg-" + c.id, contactId: c.id, kind: "message", forceSilent: c.vibrateOnly });
      playMessageSound(routeId); vibrate([80, 40, 80]);
    }
    if (state.tab === "chats") renderChatsList();
    updateAppBadge();
    return;
  }
  const m = c.messages.find((x) => x.id === payload.id); if (!m) return;
  let changed = false;
  // Закрытие опроса по времени проверяем по НАШЕМУ времени получения, а не по заявленному отправителем (иначе «ts: 1» обходил бы срок)
  if (kind === "poll-vote") changed = !EtherRich.isClosed(m) && EtherRich.applyVote(m, from, payload.opts, Math.max(clampOpTs(payload.ts, Date.now()), m.ts || 0));
  else if (kind === "poll-close") { const authorId = c.isGroup ? m.fromId : c.id; changed = m.from === "them" && authorId === from && EtherRich.closePoll(m); }
  else if (kind === "note-op") changed = !!payload.op && EtherRich.applyNoteOp(m, payload.op, clampOpTs(payload.ts, Date.now()));
  else if (kind === "board-op") changed = EtherRich.applyBoardOp(m, payload.op, clampOpTs(payload.ts, Date.now()));
  if (!changed) return;
  persistContacts();
  if (state.chatId === c.id) renderChatThread();
}
function pollVoterName(c, id) {
  if (id === Store.myId) return T("chat.poll.you");
  if (c.isGroup) { const mem = c.members.find((x) => x.id === id); if (mem && mem.name) return mem.name; }
  const k = state.contacts.get(id); return (k && k.name) || (id === c.id && c.name) || T("sys.someone");
}
const __pollTimers = new Map();
function pollBubbleHtml(c, m) {
  const t = EtherRich.tally(m), me = (m.pollVotes && m.pollVotes[Store.myId]) || [];
  const closed = EtherRich.isClosed(m);
  const max = Math.max(1, ...Object.values(t.counts));
  // Автозакрытие: один таймер на опрос — перерисовать чат в момент закрытия
  if (m.poll.closeAt && !m.poll.closed && !closed && !__pollTimers.has(m.id)) {
    __pollTimers.set(m.id, setTimeout(() => { __pollTimers.delete(m.id); if (state.chatId === c.id) renderChatThread(); }, Math.min(2147483000, m.poll.closeAt - Date.now() + 300)));
  }
  const opts = m.poll.opts.map((o) => {
    const n = t.counts[o.id] || 0, mine = me.includes(o.id);
    const pct = t.voters ? Math.round((n / t.voters) * 100) : 0;
    const who = m.poll.pub && n ? `<span class="poll-opt-who">${escapeHtml(Object.entries(m.pollVotes || {}).filter(([, v]) => Array.isArray(v) && v.includes(o.id)).map(([id]) => pollVoterName(c, id)).join(", "))}</span>` : "";
    return `<button type="button" class="poll-opt${mine ? " is-mine" : ""}" data-poll-opt="${escapeHtml(o.id)}" role="${m.poll.multi ? "checkbox" : "radio"}" aria-checked="${mine}"${closed ? " disabled" : ""}>
      <span class="poll-opt-bar" style="width:${(n / max * 100).toFixed(0)}%"></span>
      <span class="poll-opt-mark">${mine ? Icons.html("check", 14) : ""}</span>
      <span class="poll-opt-text">${escapeHtml(o.t)}${who}</span>
      <span class="poll-opt-count">${n ? pct + "%" : ""}</span>
    </button>`;
  }).join("");
  const bits = [T("chat.poll.votes", { n: t.voters })];
  if (m.poll.multi) bits.push(T("chat.poll.multiHint"));
  if (m.poll.pub) bits.push(T("chat.poll.publicHint"));
  if (m.poll.closeAt && !closed) bits.push(T("chat.poll.until", { time: formatTime(m.poll.closeAt) }));
  const foot = `<span>${escapeHtml(bits.join(" · "))}</span>`
    + (closed ? `<span class="poll-closed">${escapeHtml(T("chat.poll.closed"))}</span>` : (m.from === "me" ? `<button type="button" class="poll-close-btn" data-poll-close="1">${escapeHtml(T("chat.poll.close"))}</button>` : ""));
  return `<div class="poll-bubble${closed ? " is-closed" : ""}"><div class="poll-q">${Icons.html("poll", 16)}<span>${escapeHtml(m.poll.q)}</span></div><div class="poll-opts" role="${m.poll.multi ? "group" : "radiogroup"}" aria-label="${escapeHtml(m.poll.q)}">${opts}</div><div class="poll-foot">${foot}</div></div>`;
}
function noteBubbleHtml(m) {
  const t = m.note.text;
  return `<div class="note-bubble"><div class="note-title">${Icons.html("file", 16)}<span>${escapeHtml(m.note.title)}</span></div><div class="note-text${t ? "" : " is-empty"}">${t ? escapeHtml(t) : escapeHtml(T("chat.note.empty"))}</div><button type="button" class="note-edit-btn" data-note-edit="1">${Icons.html("edit", 14)}<span>${escapeHtml(T("chat.note.edit"))}</span></button></div>`;
}
function boardBubbleHtml(m) {
  const b = m.board;
  const cols = b.cols.map((col, ci) => {
    const cards = b.cards.filter((k) => k.col === col.id).map((k) => `<div class="board-card" data-card="${escapeHtml(k.id)}"><span class="board-card-t" data-board-act="edit" tabindex="0" role="button">${escapeHtml(k.t)}</span><span class="board-card-acts">`
      + (ci > 0 ? `<button type="button" data-board-act="left" aria-label="${escapeHtml(T("chat.board.moveLeft"))}">${Icons.html("chevron-left", 14)}</button>` : "")
      + (ci < b.cols.length - 1 ? `<button type="button" data-board-act="right" aria-label="${escapeHtml(T("chat.board.moveRight"))}">${Icons.html("chevron-right", 14)}</button>` : "")
      + `<button type="button" data-board-act="del" aria-label="${escapeHtml(T("chat.board.delete"))}">${Icons.html("x", 14)}</button></span></div>`).join("");
    return `<div class="board-col" data-col="${escapeHtml(col.id)}"><div class="board-col-h"><span class="board-col-name" data-board-act="colname" data-col="${escapeHtml(col.id)}" tabindex="0" role="button">${escapeHtml(col.t)}</span><span class="board-col-n">${b.cards.filter((k) => k.col === col.id).length}</span></div>${cards}<button type="button" class="board-add" data-board-act="add" data-col="${escapeHtml(col.id)}">${Icons.html("plus", 14)}<span>${escapeHtml(T("chat.board.addCard"))}</span></button></div>`;
  }).join("");
  return `<div class="board-bubble"><div class="board-title">${Icons.html("board", 16)}<span>${escapeHtml(b.title)}</span></div><div class="board-cols">${cols}</div></div>`;
}
function handleRichClick(c, m, el) {
  if (el.hasAttribute("data-poll-opt")) { votePoll(c.id, m.id, el.getAttribute("data-poll-opt")); return; }
  if (el.hasAttribute("data-poll-close")) { closePollMsg(c.id, m.id); return; }
  if (el.hasAttribute("data-note-edit")) { openNoteSheet(c.id, m.id); return; }
  const act = el.getAttribute("data-board-act");
  const cardEl = el.closest("[data-card]"), cardId = cardEl && cardEl.getAttribute("data-card");
  const cols = m.board.cols.map((x) => x.id);
  const card = cardId && m.board.cards.find((k) => k.id === cardId);
  if (act === "add") {
    const col = el.getAttribute("data-col");
    openTextSheet({ title: T("chat.board.addCard"), placeholder: T("chat.board.cardText"), onOk: (text) => boardOp(c.id, m.id, { t: "add", card: { id: crypto.randomUUID(), t: text, col } }) });
  } else if (act === "colname") {
    const col = el.getAttribute("data-col"), cur = m.board.cols.find((x) => x.id === col);
    if (cur) openTextSheet({ title: T("chat.board.renameCol"), value: cur.t, placeholder: T("chat.board.colName"), onOk: (name) => boardOp(c.id, m.id, { t: "colname", col, name }) });
  } else if (act === "edit" && card) {
    openTextSheet({ title: T("chat.edit"), value: card.t, placeholder: T("chat.board.cardText"), onOk: (text) => boardOp(c.id, m.id, { t: "edit", id: card.id, text }) });
  } else if ((act === "left" || act === "right") && card) {
    const i = cols.indexOf(card.col) + (act === "left" ? -1 : 1);
    if (i >= 0 && i < cols.length) boardOp(c.id, m.id, { t: "move", id: card.id, col: cols[i] });
  } else if (act === "del" && card) {
    boardOp(c.id, m.id, { t: "del", id: card.id });
  }
}
// Общая шторка ввода одной строки (карточка доски, название доски)
let __textSheetCb = null;
function openTextSheet(opts) {
  const sheet = $("#text-sheet"), input = $("#text-sheet-input"); if (!sheet || !input) return;
  __textSheetCb = opts.onOk || null;
  $("#text-sheet-title").textContent = opts.title || "";
  input.value = opts.value || ""; input.placeholder = opts.placeholder || "";
  sheet.classList.remove("hidden");
  setTimeout(() => { try { input.focus(); input.select(); } catch (e) {} }, 60);
}
function submitTextSheet() {
  const sheet = $("#text-sheet"), input = $("#text-sheet-input"); if (!sheet || !input) return;
  const v = input.value.trim(); if (!v) return;
  const cb = __textSheetCb; __textSheetCb = null;
  sheet.classList.add("hidden");
  if (cb) cb(v);
}
let __noteTarget = null;
function openNoteSheet(cid, msgId) {
  const c = state.contacts.get(cid), m = c && c.messages.find((x) => x.id === msgId); if (!m || !m.note) return;
  const sheet = $("#note-sheet"), ta = $("#note-input"); if (!sheet || !ta) return;
  __noteTarget = { cid, msgId };
  $("#note-sheet-title").textContent = m.note.title; ta.value = m.note.text; ta.maxLength = EtherRich.NOTE_MAX;
  sheet.classList.remove("hidden"); setTimeout(() => { try { ta.focus(); } catch (e) {} }, 60);
}
function openPollSheet() {
  const sheet = $("#poll-sheet"); if (!sheet) return;
  $("#poll-q-input").value = ""; $("#poll-multi-input").checked = false; $("#poll-public-input").checked = false; $("#poll-timer-input").value = "0";
  const list = $("#poll-opts-list"); list.innerHTML = "";
  for (let i = 0; i < 2; i++) addPollOptionInput();
  sheet.classList.remove("hidden");
  setTimeout(() => { try { $("#poll-q-input").focus(); } catch (e) {} }, 60);
}
function addPollOptionInput() {
  const list = $("#poll-opts-list"); if (!list || list.children.length >= EtherRich.LIM.opts) return;
  const inp = document.createElement("input");
  inp.type = "text"; inp.className = "poll-opt-input"; inp.maxLength = EtherRich.LIM.opt; inp.autocomplete = "off";
  inp.placeholder = T("chat.poll.option", { n: list.children.length + 1 });
  list.appendChild(inp);
  const add = $("#poll-add-opt-btn"); if (add) add.classList.toggle("hidden", list.children.length >= EtherRich.LIM.opts);
}
function wireRichSheets() {
  const bind = (id, fn) => { const el = $(id); if (el) el.addEventListener("click", fn); };
  bind("#chat-poll-btn", () => { collapseComposerPlus(); openPollSheet(); });
  bind("#chat-board-btn", () => { collapseComposerPlus(); openTextSheet({ title: T("chat.board.name"), value: T("chat.board.defaultTitle"), onOk: (title) => { if (state.chatId) createBoard(state.chatId, title); } }); });
  bind("#chat-note-btn", () => { collapseComposerPlus(); openTextSheet({ title: T("chat.note.name"), value: T("chat.note.defaultTitle"), onOk: (title) => { if (state.chatId) createNote(state.chatId, title); } }); });
  bind("#note-save-btn", () => { const t = __noteTarget; if (!t) return; $("#note-sheet").classList.add("hidden"); noteOp(t.cid, t.msgId, $("#note-input").value); __noteTarget = null; });
  bind("#poll-add-opt-btn", addPollOptionInput);
  bind("#poll-create-btn", async () => {
    const q = $("#poll-q-input").value.trim();
    const opts = Array.from($$("#poll-opts-list .poll-opt-input")).map((i) => i.value.trim()).filter(Boolean);
    if (!state.chatId) return;
    const hrs = parseFloat($("#poll-timer-input").value) || 0;
    const extra = { pub: $("#poll-public-input").checked, closeAt: hrs ? Date.now() + hrs * 3600e3 : undefined };
    if (await createPoll(state.chatId, q, opts, $("#poll-multi-input").checked, extra)) $("#poll-sheet").classList.add("hidden");
  });
  bind("#text-sheet-ok", submitTextSheet);
  const ti = $("#text-sheet-input"); if (ti) ti.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submitTextSheet(); } });
}
function contactCardBubbleHtml(card) {
  const name = card.name || T("sys.someone");
  const already = state.contacts.has(card.id);
  const btn = already
    ? `<span class="contact-card-already">${escapeHtml(T("toast.alreadyAdded"))}</span>`
    : `<button type="button" class="contact-card-add-btn" data-add-contact-id="${escapeHtml(card.id)}" data-add-contact-name="${escapeHtml(name)}">${escapeHtml(T("chat.contactCard.add"))}</button>`;
  return `<div class="contact-card-bubble">
    <div class="avatar avatar-sm" style="background:${avatarGradient(name)}">${escapeHtml(initials(name))}</div>
    <div class="contact-card-info"><div class="contact-card-name">${escapeHtml(name)}</div>${btn}</div>
  </div>`;
}
function addContactFromCard(id, name) {
  if (id === Store.myId) { toast(T("toast.ownId")); return; }
  if (state.contacts.has(id)) { toast(T("toast.alreadyAdded")); renderChatThread(); return; }
  if (recentlyDeletedIds.delete(id)) persistRecentlyDeleted(); // осознанное повторное добавление снимает блокировку из deleteContact
  ensureContactEntry(id, name);
  persistContacts();
  toast(T("toast.contactAdded"));
  if (onlineSet.has(id)) scheduleAutoConnect(id);
  else attemptConnectViaRelay(id).catch(() => {}); // вдруг отправитель карточки — их общий знакомый и уже к ним подключён
  renderChatThread();
}
// =====================================================================
// Исчезающие сообщения
// =====================================================================
const DISAPPEARING_PRESETS = [0, 3600000, 86400000, 604800000]; // выкл, 1ч, 1д, 1нед
// Единая точка перевода системных сообщений при показе (не при создании) —
// используется и в ленте чата, и в превью списка чатов, чтобы язык всегда
// был текущим, а не тем, что был активен в момент создания записи.
function renderSystemMessageText(m) {
  if (!m.textKey) return m.text;
  let params = m.textParams;
  if (m.textKey === "chat.disappearing.systemOnYou" || m.textKey === "chat.disappearing.systemOnThem") {
    params = Object.assign({}, m.textParams, { duration: disappearingTimerLabel((m.textParams && m.textParams.msValue) || 0) });
  }
  const translated = T(m.textKey, params);
  // Если для textKey вдруг нет перевода (например, ключ добавили в код,
  // но забыли в словаре), T() возвращает сырой ключ как есть —
  // пользователь увидел бы "group.systemAdded" вместо текста. m.text
  // хранит текст, переведённый УЖЕ работавшим переводом в момент
  // создания сообщения — используем его как подстраховку.
  return translated === m.textKey && m.text ? m.text : translated;
}
function disappearingTimerLabel(ms) {
  if (ms === 3600000) return T("chat.disappearing.1h");
  if (ms === 86400000) return T("chat.disappearing.1d");
  if (ms === 604800000) return T("chat.disappearing.1w");
  return T("chat.disappearing.off");
}
function addDisappearingSystemMessage(c, ms, byMe) {
  const key = ms
    ? (byMe ? "chat.disappearing.systemOnYou" : "chat.disappearing.systemOnThem")
    : (byMe ? "chat.disappearing.systemOffYou" : "chat.disappearing.systemOffThem");
  // duration — вложенный перевод (зависит от текущего языка на момент
  // показа, не создания), поэтому не кладём готовую строку в params —
  // держим сырое значение таймера и досчитываем duration при рендере
  // (см. ветку system-message в renderChatThreadInner).
  const params = ms ? { name: c.name || T("sys.someone"), msValue: ms } : { name: c.name || T("sys.someone") };
  const text = ms
    ? (byMe ? T("chat.disappearing.systemOnYou", { duration: disappearingTimerLabel(ms) }) : T("chat.disappearing.systemOnThem", { name: c.name || T("sys.someone"), duration: disappearingTimerLabel(ms) }))
    : (byMe ? T("chat.disappearing.systemOffYou") : T("chat.disappearing.systemOffThem", { name: c.name || T("sys.someone") }));
  c.messages.push({ id: crypto.randomUUID(), from: "system", text, textKey: key, textParams: params, ts: Date.now() });
  trimMessages(c);
}
async function setDisappearingTimer(contactId, ms) {
  const c = state.contacts.get(contactId); if (!c) return;
  ms = ms || 0;
  if (c.disappearingTimer === ms) return;
  c.disappearingTimer = ms;
  addDisappearingSystemMessage(c, ms, true);
  c.lastActivity = Date.now();
  persistContacts();
  if (state.chatId === contactId) renderChatThread();
  if (state.tab === "chats") renderChatsList();
  const actionId = crypto.randomUUID();
  await trySendOrQueue(c, actionId, { kind: "disappearing-timer", id: actionId, timer: ms });
}
