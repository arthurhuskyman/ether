"use strict";
// Часть 8 из 14 бывшего js/app.js: Файлы, изображения, голосовые. Глобальная область общая; порядок <script> важен.

// =====================================================================
// Отправка файлов/изображений/видео
// =====================================================================
// Работает только "вживую", через уже установленное P2P-соединение — как
// звонки. Офлайн-очереди через сервер для файлов нет: серверный почтовый
// ящик рассчитан на короткие текстовые конверты, а не на мегабайты
// вложений (см. README). Сами файлы хранятся в IndexedDB (не в
// localStorage вместе с остальными данными — квота localStorage на весь
// домен обычно всего 5-10 МБ, один файл её бы полностью исчерпал).

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000; // порциями — иначе String.fromCharCode(...bytes) падает на больших массивах
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function fileKindFromMime(mime) {
  if (!mime) return "file";
  // Только растровые картинки: SVG — это документ со скриптами, его нельзя показывать/открывать как изображение
  if (/^image\/(png|jpe?g|gif|webp|avif|bmp|heic|heif)$/i.test(mime)) return "image";
  if (mime.indexOf("video/") === 0) return "video";
  if (mime.indexOf("audio/") === 0) return "audio";
  return "file";
}
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}
const fileBlobUrlCache = new Map(); // msgId -> object URL, чтобы не пересоздавать при каждом ре-рендере
const FILE_BLOB_URL_CACHE_MAX = 300; // выше, чем у превью ссылок: если "on-screen" картинка/видео ссылается на blob URL, а мы его отзовём — она сломается, поэтому вытесняем осторожнее и только при реальном избытке

// Файлы/голосовые требовали, чтобы P2P-связь была уже установлена ДО
// вызова — в отличие от текста (который через trySendOrQueue сам
// пытается подключиться), это падало сразу, даже если собеседник
// онлайн и связь установилась бы за пару секунд, просто рукопожатие
// ещё не завершилось. Активно пытаемся подключиться и ждём немного,
// прежде чем сдаться.
async function ensureLiveLink(contactId, timeoutMs) {
  let link = mesh.get(contactId);
  if (link && (link.status === "connected" || link.status === "in-call")) return link;
  scheduleAutoConnect(contactId);
  attemptConnectViaRelay(contactId).catch(() => {});
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    link = mesh.get(contactId);
    if (link && (link.status === "connected" || link.status === "in-call")) return link;
  }
  return null;
}
// Сжатие изображений перед отправкой — canvas, прогрессивное снижение
// качества/разрешения, пока не уложится в целевой размер (или пока не
// кончатся попытки). PNG с прозрачностью тоже конвертируется в JPEG
// (белая подложка вместо прозрачности) — для типичного случая "отправить
// фото" это подходящий компромисс; если после этого всё равно больше
// целевого размера, возвращаем null — вызывающий код решает, что делать
// (отклонить с понятной ошибкой, а не молча отправить гигантский файл).
async function compressImageToTarget(file, maxBytes) {
  if (!file.type || file.type.indexOf("image/") !== 0) return null;
  if (file.type === "image/svg+xml" || file.type === "image/gif") return null; // векторные/анимация — сжимать растрово нет смысла
  let bitmap;
  try { bitmap = await createImageBitmap(file); }
  catch (e) { return null; }
  const MAX_DIM = 1920; // разумное разрешение для сообщения в чате, не для печати
  let { width, height } = bitmap;
  if (width > MAX_DIM || height > MAX_DIM) {
    const scale = MAX_DIM / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, width, height); // подложка под прозрачность
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close && bitmap.close();
  const qualities = [0.85, 0.7, 0.55, 0.4];
  for (const q of qualities) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", q));
    if (blob && blob.size <= maxBytes) return blob;
  }
  // Качество исчерпано — последняя попытка: уменьшаем ещё разрешение
  // вдвое. КРИТИЧНО: раньше здесь переиспользовался ТОТ ЖЕ canvas —
  // присвоение canvas.width/height стирает его содержимое по спецификации
  // HTML, а следующая строка пыталась рисовать ИЗ этого canvas В НЕГО ЖЕ,
  // уже пустого. На выходе — чистый белый прямоугольник вместо сжатого
  // фото. Если это "пустое" изображение укладывалось в maxBytes (а
  // укладывалось почти всегда — кодировать нечего), оно тихо уходило
  // получателю как якобы успешно сжатый результат. Реальный эффект: любое
  // обычное фото с телефона (3-4МБ, где q=0.4 уже не хватает) получало
  // либо пустую картинку, либо отказ — рабочего пути не было вовсе.
  // Фикс: отдельный, новый canvas для уменьшенной копии.
  if (width > 640 && height > 640) {
    const temp = document.createElement("canvas");
    temp.width = Math.round(width / 2);
    temp.height = Math.round(height / 2);
    const ctx2 = temp.getContext("2d");
    ctx2.fillStyle = "#fff"; ctx2.fillRect(0, 0, temp.width, temp.height);
    ctx2.drawImage(canvas, 0, 0, width, height, 0, 0, temp.width, temp.height);
    const blob = await new Promise((resolve) => temp.toBlob(resolve, "image/jpeg", 0.6));
    if (blob && blob.size <= maxBytes) return blob;
  }
  return null;
}
// Единая точка входа для файлов, выбранных через скрепку ИЛИ системную
// камеру (P1.11 мультивыбор + P1.12 превью с подписью перед отправкой).
// Один файл-изображение/видео — превью-шит с полем подписи. Несколько
// файлов сразу, или один файл другого типа — отправляются как раньше,
// без промежуточного экрана (для документов подпись не так полезна,
// а шит на 10 файлов подряд был бы утомителен).
let __pendingComposeFile = null;
function handlePickedFiles(files) {
  if (!files.length || !state.chatId) return;
  if (files.length === 1) {
    const kind = fileKindFromMime(files[0].type);
    if (kind === "image" || kind === "video") { openMediaComposeSheet(files[0]); return; }
    sendFileMessage(state.chatId, files[0]);
    return;
  }
  // Несколько файлов — та же логика, что для одного, но без тостов на
  // каждый (sendFileMessage(..., {silent:true})), иначе 10 файлов дают
  // 10 "Connecting…" тостов подряд.
  const contactId = state.chatId;
  (async () => {
    for (const f of files) { try { await sendFileMessage(contactId, f, { silent: true }); } catch (e) {} }
  })();
}
function openMediaComposeSheet(file) {
  __pendingComposeFile = file;
  const preview = $("#media-compose-preview");
  const captionInput = $("#media-compose-caption");
  if (captionInput) captionInput.value = "";
  if (preview) {
    preview.innerHTML = "";
    const url = URL.createObjectURL(file);
    const isVideo = fileKindFromMime(file.type) === "video";
    const el = document.createElement(isVideo ? "video" : "img");
    el.src = url;
    if (isVideo) { el.controls = true; el.playsInline = true; } else { el.alt = ""; }
    // Шит может быть закрыт без отправки (Cancel/backdrop) — освобождаем
    // object URL при следующем открытии, а не копим их бесконечно.
    preview.dataset.objectUrl = url;
    preview.appendChild(el);
  }
  const sheet = $("#media-compose-sheet"); if (sheet) sheet.classList.remove("hidden");
  setTimeout(() => { if (captionInput) captionInput.focus(); }, 50);
}
function closeMediaComposeSheet() {
  const preview = $("#media-compose-preview");
  if (preview && preview.dataset.objectUrl) { try { URL.revokeObjectURL(preview.dataset.objectUrl); } catch (e) {} delete preview.dataset.objectUrl; }
  __pendingComposeFile = null;
  const sheet = $("#media-compose-sheet"); if (sheet) sheet.classList.add("hidden");
}
function wireMediaComposeSheet() {
  const sendBtn = $("#media-compose-send");
  if (sendBtn) sendBtn.addEventListener("click", () => {
    const file = __pendingComposeFile;
    const contactId = state.chatId;
    const captionInput = $("#media-compose-caption");
    const caption = captionInput ? captionInput.value.trim() : "";
    closeMediaComposeSheet();
    if (file && contactId) sendFileMessage(contactId, file, { caption });
  });
  const sheet = $("#media-compose-sheet");
  if (sheet) {
    // Доп. к общему wireSheetBackdrops (который просто прячет шторку) —
    // освобождаем object URL превью, иначе он утекает до следующего
    // открытия шита.
    const backdrop = sheet.querySelector(".sheet-backdrop");
    if (backdrop) backdrop.addEventListener("click", closeMediaComposeSheet);
    const cancelBtn = sheet.querySelector(".sheet-cancel");
    if (cancelBtn) cancelBtn.addEventListener("click", closeMediaComposeSheet);
  }
}
// В группе вложение уходит каждому участнику отдельной копией (один зашифрованный конверт на человека), поэтому потолок
// ниже, чем в личном чате: 1 МБ вместо 2 МБ (картинки сжимаются под него автоматически).
const GROUP_FILE_MAX = 1024 * 1024;
async function sendFileMessage(contactId, file, opts) {
  opts = opts || {};
  const caption = typeof opts.caption === "string" ? opts.caption.trim().slice(0, 200) : "";
  const silent = !!opts.silent; // при массовой отправке (P1.11) не плодим тост на каждый файл
  const c = state.contacts.get(contactId); if (!c) return;
  const inGroup = isGroup(c);
  const sizeCap = inGroup ? GROUP_FILE_MAX : MAX_FILE_SIZE;
  if (!inGroup && c.blocked) { toast(T("toast.blocked")); return; }
  // Раньше нижней границы не было вовсе — пустой (0 байт) файл
  // отправитель видел как "отправлено", а handleFilePayload на
  // стороне получателя (через EtherFileLimits.isValidFileMetaSize,
  // где size > 0) молча его отбрасывал. Симметрично отклоняем уже
  // здесь, с понятным сообщением, а не тихим расхождением.
  if (file.size === 0) { toast(T("toast.fileEmpty")); return; }
  if (file.size > MAX_FILE_SIZE_INPUT) { toast(T("toast.fileTooLarge", { size: formatFileSize(MAX_FILE_SIZE_INPUT) })); return; }
  // Целевой потолок того, что реально уходит — 2МБ. Если исходник
  // больше и это изображение — пробуем сжать автоматически, вместо
  // того чтобы сразу отказывать. Итоговый Blob подменяет исходный
  // file для всего остального пути (P2P/офлайн-очередь его не
  // различают — им важен только размер и содержимое).
  if (file.size > sizeCap) {
    const compressed = await compressImageToTarget(file, sizeCap);
    if (compressed) {
      const origName = file.name || "photo.jpg";
      const newName = origName.replace(/\.[^.]+$/, "") + ".jpg";
      file = new File([compressed], newName, { type: "image/jpeg" });
    } else {
      toast(T("toast.fileTooLarge", { size: formatFileSize(sizeCap) }));
      return;
    }
  }
  if (inGroup) { await sendGroupFile(contactId, file, { caption }); return; }
  if (typeof Devices !== "undefined" && Devices.needsServer(c)) { await sendFileOffline(contactId, file, { caption }); return; } // есть другие устройства: вложение идёт через ящик, чтобы его увидели все
  const existingLink = mesh.get(contactId);
  const alreadyLive = existingLink && (existingLink.status === "connected" || existingLink.status === "in-call");
  if (!alreadyLive && !silent) toast(T("toast.connecting"));
  const link = alreadyLive ? existingLink : await ensureLiveLink(contactId, 8000);
  if (!link) {
    // Раньше тут просто отказывали — теперь, поскольку file гарантированно
    // уже ≤ MAX_FILE_SIZE (2МБ, с большим запасом до серверного
    // MAX_PAYLOAD в 8МБ даже с учётом base64), шлём через тот же
    // зашифрованный почтовый ящик сервера, что и текст (sendFileOffline
    // ниже), вместо жёсткого отказа.
    await sendFileOffline(contactId, file, { caption });
    return;
  }

  const msgId = crypto.randomUUID();
  const ts = Date.now();
  const rec = {
    id: msgId, from: "me", text: "", ts, ack: "sent", serverAcked: false,
    file: { name: file.name, mime: file.type || "application/octet-stream", size: file.size, kind: fileKindFromMime(file.type), pending: true, progress: 0 },
  };
  if (caption) rec.file.caption = caption;
  if (c.disappearingTimer) rec.ttl = c.disappearingTimer; // таймер исчезновения действует и на файлы/голосовые
  c.messages.push(rec); trimMessages(c); c.lastActivity = ts; persistContacts();
  if (state.chatId === contactId) { renderChatThreadInner(); const wrap = $("#chat-messages"); if (wrap) wrap.scrollTop = wrap.scrollHeight; }
  if (state.tab === "chats") renderChatsList();

  let buffer;
  try { buffer = await file.arrayBuffer(); }
  catch (e) { rec.file.pending = false; rec.ack = "failed"; persistContacts(); if (state.chatId === contactId) renderChatThreadInner(); return; }

  try { await IDB.set("file:" + msgId, new Blob([buffer], { type: rec.file.mime })); } catch (e) {}

  const chunks = [];
  for (let offset = 0; offset < buffer.byteLength; offset += FILE_CHUNK_SIZE) {
    chunks.push(arrayBufferToBase64(buffer.slice(offset, offset + FILE_CHUNK_SIZE)));
  }
  const ok = await link.sendFile({ id: msgId, name: file.name, mime: rec.file.mime, size: file.size, caption: caption || undefined }, chunks, (done, total) => {
    rec.file.progress = total > 0 ? done / total : 0;
    const el = document.querySelector(`.file-bubble[data-msg-id="${CSS.escape(msgId)}"] .file-progress-fill`);
    if (el) el.style.width = (rec.file.progress * 100).toFixed(1) + "%";
  });
  rec.file.pending = false;
  rec.ack = ok ? "sent" : "failed";
  persistContacts();
  if (state.chatId === contactId) renderChatThreadInner();
  if (state.tab === "chats") renderChatsList();
  if (!ok) toast(T("toast.fileSendFailed"));
}

// Вложение или голосовое в группу: одна запись в ленте группы + отдельный зашифрованный конверт каждому участнику
// (тот же путь, что у sendGroupMessage: свой deliveryId на получателя, ack сопоставляется через groupDeliveryMap).
async function sendGroupFile(groupId, file, meta) {
  const g = state.contacts.get(groupId); if (!g || !g.isGroup) return;
  if (!isGroupWriteAllowed(g, Store.myId)) { toast(T("toast.groupWriteRestricted")); return; }
  meta = meta || {};
  if (!file || file.size === 0) { toast(T("toast.fileEmpty")); return; }
  if (file.size > GROUP_FILE_MAX || !EtherFileLimits.isValidFileMetaSize(file.size)) { toast(T("toast.fileTooLarge", { size: formatFileSize(GROUP_FILE_MAX) })); return; } // до чтения и base64
  const mime = file.type || meta.mime || "application/octet-stream";
  const name = meta.name || file.name || "file";
  const caption = typeof meta.caption === "string" ? meta.caption.trim().slice(0, 200) : "";
  const msgId = crypto.randomUUID();
  const ts = Date.now();
  const rec = {
    id: msgId, from: "me", text: "", ts, ack: "sent",
    file: { name, mime, size: file.size, kind: fileKindFromMime(mime), pending: true },
  };
  if (meta.duration) rec.file.duration = meta.duration;
  if (meta.wave) rec.file.wave = meta.wave;
  if (caption) rec.file.caption = caption;
  if (g.disappearingTimer) rec.ttl = g.disappearingTimer;
  g.messages.push(rec); trimMessages(g); g.lastActivity = ts; persistContacts();
  if (state.chatId === groupId) { renderChatThreadInner(); const wrap = $("#chat-messages"); if (wrap) wrap.scrollTop = wrap.scrollHeight; }
  if (state.tab === "chats") renderChatsList();
  let buffer;
  try { buffer = await file.arrayBuffer(); }
  catch (e) { rec.file.pending = false; rec.ack = "failed"; persistContacts(); if (state.chatId === groupId) renderChatThreadInner(); return; }
  try { await IDB.set("file:" + msgId, new Blob([buffer], { type: mime })); } catch (e) {}
  const payload = { kind: "file", id: msgId, ts, name, mime, size: file.size, dataB64: arrayBufferToBase64(buffer), groupId, senderName: Store.name || T("sys.someone") };
  if (meta.duration) payload.duration = meta.duration;
  if (meta.wave) payload.wave = meta.wave;
  if (caption) payload.caption = caption;
  if (g.disappearingTimer) payload.ttl = g.disappearingTimer;
  playOutgoingSound();
  for (const m of g.members) {
    if (m.id === Store.myId) continue;
    const mc = ensureContactEntry(m.id, m.name);
    const deliveryId = crypto.randomUUID();
    groupDeliveryMap.set(deliveryId, { groupId, contentId: msgId, to: m.id });
    trimMap(groupDeliveryMap, GROUP_DELIVERY_MAP_LIMIT);
    persistGroupDeliveryMap();
    await trySendOrQueue(mc, deliveryId, payload);
  }
  rec.file.pending = false;
  persistContacts();
  if (state.chatId === groupId) renderChatThreadInner();
  if (state.tab === "chats") renderChatsList();
}

// Путь через почтовый ящик сервера для небольших файлов, когда
// собеседник офлайн (P2P недоступен даже после ensureLiveLink). Один
// зашифрованный payload одним сообщением — БЕЗ чанкования, в отличие
// от живой P2P-передачи (там chunks через link.sendFile). Переиспользует
// ровно тот же trySendOrQueue/почтовый ящик, что и текстовые сообщения
// — сервер не видит содержимого файла, только зашифрованный envelope,
// как и для текста.
async function sendFileOffline(contactId, file, opts) {
  opts = opts || {};
  const caption = typeof opts.caption === "string" ? opts.caption.trim().slice(0, 200) : "";
  const c = state.contacts.get(contactId); if (!c) return;
  const msgId = crypto.randomUUID();
  const ts = Date.now();
  const rec = {
    id: msgId, from: "me", text: "", ts, ack: "sent", serverAcked: false,
    file: { name: file.name, mime: file.type || "application/octet-stream", size: file.size, kind: fileKindFromMime(file.type), pending: true },
  };
  if (caption) rec.file.caption = caption;
  if (c.disappearingTimer) rec.ttl = c.disappearingTimer; // таймер исчезновения действует и на файлы/голосовые
  c.messages.push(rec); trimMessages(c); c.lastActivity = ts; persistContacts();
  if (state.chatId === contactId) { renderChatThreadInner(); const wrap = $("#chat-messages"); if (wrap) wrap.scrollTop = wrap.scrollHeight; }
  if (state.tab === "chats") renderChatsList();

  let buffer;
  try { buffer = await file.arrayBuffer(); }
  catch (e) { rec.file.pending = false; rec.ack = "failed"; persistContacts(); if (state.chatId === contactId) renderChatThreadInner(); return; }
  try { await IDB.set("file:" + msgId, new Blob([buffer], { type: rec.file.mime })); } catch (e) {}

  const payload = { kind: "file", id: msgId, name: file.name, mime: rec.file.mime, size: file.size, dataB64: arrayBufferToBase64(buffer) };
  if (caption) payload.caption = caption;
  if (rec.ttl) payload.ttl = rec.ttl;
  await trySendOrQueue(c, msgId, payload);
  rec.file.pending = false;
  persistContacts();
  if (state.chatId === contactId) renderChatThreadInner();
  if (state.tab === "chats") renderChatsList();
}
// Переиспользует ровно ту же инфраструктуру, что и обычные файлы (P2P
// только "вживую", хранение блоба в IndexedDB) — отличается только UI
// записи и типом отрисовки пузыря (проигрыватель вместо файла).
async function sendVoiceMessage(contactId, blob, durationSec, wave) {
  const c = state.contacts.get(contactId); if (!c) return;
  const inGroup = isGroup(c);
  if (!inGroup && c.blocked) { toast(T("toast.blocked")); return; }
  // Та же симметрия, что в sendFileMessage — на всякий случай, если
  // запись почему-то дала пустой blob (получатель бы его всё равно
  // молча отбросил через isValidFileMetaSize).
  if (blob.size === 0) { toast(T("toast.fileEmpty")); return; }
  const voiceCap = inGroup ? GROUP_FILE_MAX : MAX_FILE_SIZE;
  if (blob.size > voiceCap) { toast(T("toast.fileTooLarge", { size: formatFileSize(voiceCap) })); return; }
  if (inGroup) { await sendGroupFile(contactId, blob, { name: "voice-message", duration: durationSec, wave, mime: blob.type || "audio/webm" }); return; }
  if (typeof Devices !== "undefined" && Devices.needsServer(c)) { await sendVoiceOffline(contactId, blob, durationSec, wave); return; }
  const existingLink2 = mesh.get(contactId);
  const alreadyLive2 = existingLink2 && (existingLink2.status === "connected" || existingLink2.status === "in-call");
  if (!alreadyLive2) toast(T("toast.connecting"));
  const link = alreadyLive2 ? existingLink2 : await ensureLiveLink(contactId, 8000);
  if (!link) {
    // Размер уже гарантированно ≤ MAX_FILE_SIZE (проверка чуть выше) —
    // офлайн-путь всегда доступен, отдельная проверка не нужна.
    await sendVoiceOffline(contactId, blob, durationSec, wave);
    return;
  }

  const msgId = crypto.randomUUID();
  const ts = Date.now();
  const mime = blob.type || "audio/webm";
  const rec = {
    id: msgId, from: "me", text: "", ts, ack: "sent", serverAcked: false,
    file: { name: "voice-message", mime, size: blob.size, kind: "audio", duration: durationSec, wave, pending: true },
  };
  if (c.disappearingTimer) rec.ttl = c.disappearingTimer; // таймер исчезновения действует и на файлы/голосовые
  c.messages.push(rec); trimMessages(c); c.lastActivity = ts; persistContacts();
  if (state.chatId === contactId) { renderChatThreadInner(); const wrap = $("#chat-messages"); if (wrap) wrap.scrollTop = wrap.scrollHeight; }
  if (state.tab === "chats") renderChatsList();

  let buffer;
  try { buffer = await blob.arrayBuffer(); }
  catch (e) { rec.file.pending = false; rec.ack = "failed"; persistContacts(); if (state.chatId === contactId) renderChatThreadInner(); return; }

  try { await IDB.set("file:" + msgId, new Blob([buffer], { type: mime })); } catch (e) {}

  const chunks = [];
  for (let offset = 0; offset < buffer.byteLength; offset += FILE_CHUNK_SIZE) {
    chunks.push(arrayBufferToBase64(buffer.slice(offset, offset + FILE_CHUNK_SIZE)));
  }
  const ok = await link.sendFile({ id: msgId, name: "voice-message", mime, size: blob.size, duration: durationSec, wave }, chunks);
  rec.file.pending = false;
  rec.ack = ok ? "sent" : "failed";
  persistContacts();
  if (state.chatId === contactId) renderChatThreadInner();
  if (state.tab === "chats") renderChatsList();
  if (!ok) toast(T("toast.fileSendFailed"));
}
// Голосовой аналог sendFileOffline — тот же принцип (один зашифрованный
// payload через почтовый ящик сервера, без чанкования), плюс duration
// в записи для правильной отрисовки плеера.
async function sendVoiceOffline(contactId, blob, durationSec, wave) {
  const c = state.contacts.get(contactId); if (!c) return;
  const msgId = crypto.randomUUID();
  const ts = Date.now();
  const mime = blob.type || "audio/webm";
  const rec = {
    id: msgId, from: "me", text: "", ts, ack: "sent", serverAcked: false,
    file: { name: "voice-message", mime, size: blob.size, kind: "audio", duration: durationSec, wave, pending: true },
  };
  if (c.disappearingTimer) rec.ttl = c.disappearingTimer; // таймер исчезновения действует и на файлы/голосовые
  c.messages.push(rec); trimMessages(c); c.lastActivity = ts; persistContacts();
  if (state.chatId === contactId) { renderChatThreadInner(); const wrap = $("#chat-messages"); if (wrap) wrap.scrollTop = wrap.scrollHeight; }
  if (state.tab === "chats") renderChatsList();

  let buffer;
  try { buffer = await blob.arrayBuffer(); }
  catch (e) { rec.file.pending = false; rec.ack = "failed"; persistContacts(); if (state.chatId === contactId) renderChatThreadInner(); return; }
  try { await IDB.set("file:" + msgId, new Blob([buffer], { type: mime })); } catch (e) {}

  const payload = { kind: "file", id: msgId, name: "voice-message", mime, size: blob.size, duration: durationSec, wave, dataB64: arrayBufferToBase64(buffer) };
  if (rec.ttl) payload.ttl = rec.ttl;
  await trySendOrQueue(c, msgId, payload);
  rec.file.pending = false;
  persistContacts();
  if (state.chatId === contactId) renderChatThreadInner();
  if (state.tab === "chats") renderChatsList();
}

function pickVoiceMimeType() {
  const candidates = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  for (const c of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}
let voiceRecorder = null, voiceRecordStream = null, voiceRecordChunks = [], voiceRecordStartedAt = 0, voiceRecordTimerId = null;
let voiceRecordStarting = false;
let voiceWaveSamples = [], voiceRecordPaused = false, voiceRecordPausedAt = 0, voiceRecordPausedTotal = 0;
function voiceRecordElapsedSec() { return Math.max(0, (Date.now() - voiceRecordStartedAt - voiceRecordPausedTotal - (voiceRecordPaused ? Date.now() - voiceRecordPausedAt : 0)) / 1000); }
let voiceRecordCancelPending = false; // чат покинули, пока висел getUserMedia
let voiceRecordBytes = 0, voiceRecordWarned = false, voiceRecordCapBytes = 0; // B1: размер записи (сумма чанков) и потолок для автостопа
const VOICE_CAP_WARN_SEC = 10; // за сколько секунд до лимита предупредить
const VOICE_BPS_BYTES = 96000 / 8 * 1.1; // оценка байт/с (audioBitsPerSecond=96000 + запас на контейнер)
let voiceRecordTargetChatId = null; // чат, в котором НАЧАЛАСЬ запись — используется при остановке, а не state.chatId в тот момент (пользователь мог переключиться в другой чат за время записи)
// Реальный level meter поверх MediaRecorder (раздел 6 роадмапа) — раньше
// 5 столбиков .voice-recording-wave просто бесконечно крутили одну и ту же
// CSS @keyframes-анимацию (честно задокументировано как "декоративный
// эффект" в комментарии в styles.css). Теперь, если Web Audio доступен,
// AnalyserNode читает РЕАЛЬНУЮ громкость микрофона и двигает те же самые
// столбики через requestAnimationFrame; если AudioContext недоступен (или
// браузер запретил) — тихо остаёмся на старой декоративной CSS-анимации,
// см. комментарий в startVoiceLevelMeter.
let voiceAudioCtx = null, voiceAnalyser = null, voiceLevelRaf = null;
let voiceLevelHistory = [0, 0, 0, 0, 0]; // 5 последних замеров громкости — по одному на столбик, "скользящее окно" примерно последних ~450мс
function startVoiceLevelMeter(stream) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return; // progressive enhancement — без Web Audio столбики просто продолжают крутить старую CSS-анимацию
    voiceAudioCtx = new AC();
    const source = voiceAudioCtx.createMediaStreamSource(stream);
    voiceAnalyser = voiceAudioCtx.createAnalyser();
    voiceAnalyser.fftSize = 256;
    // source подключается ТОЛЬКО к analyser, не к voiceAudioCtx.destination —
    // иначе пользователь услышал бы собственный голос эхом через динамики
    // прямо во время записи.
    source.connect(voiceAnalyser);
    const data = new Uint8Array(voiceAnalyser.fftSize);
    const bars = document.querySelectorAll("#voice-recording-bar .voice-recording-wave span");
    bars.forEach((b) => { b.style.animation = "none"; });
    let lastSampleAt = 0;
    const tick = (now) => {
      voiceLevelRaf = requestAnimationFrame(tick);
      if (!voiceAnalyser || voiceRecordPaused) return;
      if (now - lastSampleAt < 90) return; // ~11 замеров/сек — глазу достаточно, не гоняем лишний раз getByteTimeDomainData+DOM на каждый rAF (обычно 60/сек)
      lastSampleAt = now;
      voiceAnalyser.getByteTimeDomainData(data);
      let sumSq = 0;
      for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sumSq += v * v; }
      const rms = Math.sqrt(sumSq / data.length); // ~0..1, обычная речь даёт 0.05–0.2
      voiceLevelHistory.push(rms);
      voiceLevelHistory.shift();
      if (!voiceWaveSamples.length) { const lead = Math.min(8, Math.round(voiceRecordElapsedSec() * 1000 / 90)); for (let k = 0; k < lead; k++) voiceWaveSamples.push(rms); }
      voiceWaveSamples.push(rms);
      bars.forEach((b, i) => {
        const level = Math.min(1, voiceLevelHistory[i] * 3.5); // усиление — иначе столбики почти не двигались бы на тихой речи
        b.style.transform = `scaleY(${(0.35 + level * 1.15).toFixed(2)})`;
        b.style.opacity = (0.55 + level * 0.45).toFixed(2);
      });
    };
    voiceLevelRaf = requestAnimationFrame(tick);
  } catch (e) {
    // AnalyserNode недоступен/запрещён политикой браузера — тихо остаёмся
    // на декоративной CSS-анимации, это не критическая ошибка записи.
  }
}
function stopVoiceLevelMeter() {
  if (voiceLevelRaf) { cancelAnimationFrame(voiceLevelRaf); voiceLevelRaf = null; }
  voiceAnalyser = null;
  if (voiceAudioCtx) { try { voiceAudioCtx.close(); } catch (e) {} voiceAudioCtx = null; }
  voiceLevelHistory = [0, 0, 0, 0, 0];
  const bars = document.querySelectorAll("#voice-recording-bar .voice-recording-wave span");
  bars.forEach((b) => { b.style.animation = ""; b.style.transform = ""; b.style.opacity = ""; });
}
async function startVoiceRecording() {
  if (!state.chatId) return;
  if (voiceRecorder || voiceRecordStarting) return; // защита и от повторного вызова, и от гонки — getUserMedia асинхронный, voiceRecorder присваивается только после него
  voiceRecordStarting = true;
  voiceRecordCancelPending = false;
  voiceRecordTargetChatId = state.chatId;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    toast(T("toast.voiceUnsupported")); voiceRecordStarting = false; return;
  }
  try {
    // Голос для записи: шумоподавление и АРУ включены, эхоподавление не нужно (нет собеседника) — оно «дышит» и даёт артефакты
    try { voiceRecordStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: { ideal: 48000 } } }); }
    catch (e0) { voiceRecordStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  } catch (e) {
    toast(T("toast.voiceNoMic")); voiceRecordStarting = false; return;
  }
  if (voiceRecordCancelPending) {
    voiceRecordCancelPending = false; voiceRecordStarting = false;
    voiceRecordStream.getTracks().forEach((t) => t.stop()); voiceRecordStream = null;
    return;
  }
  const mimeType = pickVoiceMimeType();
  try {
    const recOpts = { audioBitsPerSecond: 96000 };
    if (mimeType) recOpts.mimeType = mimeType;
    try { voiceRecorder = new MediaRecorder(voiceRecordStream, recOpts); }
    catch (e1) { voiceRecorder = mimeType ? new MediaRecorder(voiceRecordStream, { mimeType }) : new MediaRecorder(voiceRecordStream); }
  } catch (e) {
    toast(T("toast.voiceUnsupported"));
    voiceRecordStream.getTracks().forEach((t) => t.stop()); voiceRecordStream = null;
    voiceRecordStarting = false;
    return;
  }
  // Даём микрофону/АРУ «прогреться» ~150 мс: сразу после getUserMedia первые кадры содержат щелчок и нестабильный уровень — это и были «артефакты в начале записи»
  await new Promise((r) => setTimeout(r, 150));
  if (voiceRecordCancelPending) {
    voiceRecordCancelPending = false; voiceRecordStarting = false;
    try { voiceRecordStream.getTracks().forEach((t) => t.stop()); } catch (e) {} voiceRecordStream = null; voiceRecorder = null;
    return;
  }
  voiceRecordStarting = false;
  // локальный массив: финальный dataavailable приходит ПОСЛЕ того, как stopVoiceRecording обнулил глобальную переменную
  const recChunks = []; voiceRecordChunks = recChunks;
  voiceRecordBytes = 0; voiceRecordWarned = false;
  { const tc = state.contacts.get(voiceRecordTargetChatId); voiceRecordCapBytes = (tc && isGroup(tc)) ? GROUP_FILE_MAX : MAX_FILE_SIZE; }
  voiceRecorder.addEventListener("dataavailable", (ev) => { if (ev.data && ev.data.size > 0) { recChunks.push(ev.data); voiceRecordBytes += ev.data.size; } });
  // start(200): запрашиваем чанк каждые 200мс вместо одного финального
  // при stop(). На iOS одиночный stop() в конце длинной записи может
  // занимать 1-2 секунды, пока весь кодек-буфер дойдёт до JS. С
  // периодическими чанками stop() завершается практически мгновенно.
  voiceRecorder.start(200);
  voiceRecordStartedAt = Date.now();
  voiceWaveSamples = []; voiceRecordPaused = false; voiceRecordPausedTotal = 0;
  setVoicePauseUi(false);
  const form = $("#chat-form"); if (form) form.classList.add("hidden");
  const bar = $("#voice-recording-bar"); if (bar) bar.classList.remove("hidden");
  const timeEl = $("#voice-recording-time");
  voiceRecordTimerId = setInterval(() => {
    if (timeEl) timeEl.textContent = formatVoiceDuration(voiceRecordElapsedSec());
    voiceRecordLimitCheck();
  }, 200);
  // AudioContext для индикатора уровня создаём не в момент старта записи — иначе на iOS смена частоты аудиосессии даёт щелчок в записи
  const meterStream = voiceRecordStream;
  setTimeout(() => { if (voiceRecorder && voiceRecordStream && voiceRecordStream === meterStream) { stopVoiceLevelMeter(); startVoiceLevelMeter(voiceRecordStream); } }, 600); // свой поток: устаревший таймер от прошлой записи не заводит второй измеритель
}
// B1: без лимита запись > потолка файла (2 МБ ≈ 175 с, группа 1 МБ ≈ 87 с) не отправлялась и
// терялась. Теперь за VOICE_CAP_WARN_SEC до потолка показываем предупреждение, а у потолка
// останавливаем и отправляем то, что записано.
function voiceRecordLimitCheck() {
  if (!voiceRecorder || voiceRecordPaused || !voiceRecordCapBytes) return;
  const rate = VOICE_BPS_BYTES;
  const left = (voiceRecordCapBytes - voiceRecordBytes) / rate; // осталось секунд до потолка
  if (left <= 1) { toast(T("toast.voiceLimitReached")); stopVoiceRecording(true); return; }
  if (left <= VOICE_CAP_WARN_SEC && !voiceRecordWarned) { voiceRecordWarned = true; toast(T("toast.voiceLimitSoon", { sec: Math.round(left) })); }
}
// Запись привязана к конкретному чату (voiceRecordTargetChatId) — если
// пользователь уходит из этого чата, не дожидаясь окончания записи,
// честнее отменить её совсем, чем оставлять полоску записи висеть
// поверх экрана другого чата, создавая путаницу насчёт того, куда
// голосовое реально уйдёт.
function cancelVoiceRecordingIfLeavingChat(newChatId) {
  if (voiceRecordTargetChatId && newChatId !== voiceRecordTargetChatId) {
    if (voiceRecorder) stopVoiceRecording(false);
    else if (voiceRecordStarting) voiceRecordCancelPending = true;
  }
}
function setVoicePauseUi(paused) {
  const bar = $("#voice-recording-bar"); if (bar) bar.classList.toggle("is-paused", !!paused);
  const btn = $("#voice-pause-btn"); if (!btn) return;
  btn.innerHTML = paused ? Icons.html("mic", 20) : Icons.html("pause", 20);
  const label = T(paused ? "chat.voice.resume" : "chat.voice.pause");
  btn.setAttribute("aria-label", label); btn.title = label;
  const note = $("#voice-recording-note"); if (note) note.textContent = T(paused ? "chat.voice.paused" : "chat.voice.recording");
}
// Пауза записи: MediaRecorder.pause() не пишет тишину в файл, время паузы в длительность не входит.
function toggleVoiceRecordingPause() {
  if (!voiceRecorder || voiceRecordStarting) return;
  try {
    if (!voiceRecordPaused) { voiceRecorder.pause(); voiceRecordPaused = true; voiceRecordPausedAt = Date.now(); }
    else { voiceRecorder.resume(); voiceRecordPausedTotal += Date.now() - voiceRecordPausedAt; voiceRecordPaused = false; }
  } catch (e) { return; }
  setVoicePauseUi(voiceRecordPaused);
}
function stopVoiceRecording(send) {
  if (voiceRecordStarting) { voiceRecordCancelPending = true; return; } // отпустили в момент прогрева микрофона — запись ещё не началась
  const contactId = voiceRecordTargetChatId;
  const durationSec = voiceRecordElapsedSec();
  const waveOut = compressWave(voiceWaveSamples);
  voiceWaveSamples = []; voiceRecordPaused = false; voiceRecordPausedTotal = 0; setVoicePauseUi(false);
  if (voiceRecordTimerId) { clearInterval(voiceRecordTimerId); voiceRecordTimerId = null; }
  stopVoiceLevelMeter();
  const form = $("#chat-form"); if (form) form.classList.remove("hidden");
  const bar = $("#voice-recording-bar"); if (bar) bar.classList.add("hidden");
  if (!voiceRecorder) return;
  const recorder = voiceRecorder;
  const mimeType = recorder.mimeType || "audio/webm";
  // Снимки локально, ДО того, как снимем voiceRecorder — recorder.stop()
  // асинхронный ("stop" может сработать через 50-300мс), и если
  // пользователь успеет нажать "Записать" снова до этого момента,
  // startVoiceRecording() (её guard смотрит только на voiceRecorder,
  // который мы уже обнулили) перезапишет voiceRecordStream и
  // voiceRecordChunks живыми данными НОВОЙ записи. Без снимков этот
  // обработчик "stop" остановил бы поток новой записи и отправил бы
  // чанки новой записи под длительностью старой.
  const streamSnapshot = voiceRecordStream;
  const chunksSnapshot = voiceRecordChunks;
  voiceRecorder = null;
  voiceRecordStream = null;
  voiceRecordChunks = [];
  let finalized = false;
  const finalize = () => {
    if (finalized) return; finalized = true;
    if (streamSnapshot) streamSnapshot.getTracks().forEach((t) => t.stop());
    if (!send || durationSec < 0.6) return; // случайное короткое нажатие — не отправляем пустышку
    const blob = new Blob(chunksSnapshot, { type: mimeType });
    if (contactId) sendVoiceMessage(contactId, blob, durationSec, waveOut);
  };
  recorder.addEventListener("stop", finalize);
  // B11: recorder уже inactive (браузер/ОС остановили, трек оборван) — stop() бросит и "stop" не придёт:
  // собираем голосовое из уже накопленных чанков.
  if (recorder.state === "inactive") { finalize(); return; }
  try { recorder.stop(); } catch (e) { finalize(); }
}

const incomingFileBuffers = new Map(); // id -> { name, mime, size, totalChunks, chunks: [] }
const MAX_INCOMING_FILE_TRANSFERS = 20; // одновременных незавершённых приёмов файлов
const INCOMING_FILE_BUFFER_TTL_MS = 3 * 60 * 1000; // брошенная (недокачанная) запись живёт не дольше этого
function sweepIncomingFileBuffers() {
  const now = Date.now();
  for (const [id, buf] of incomingFileBuffers) {
    if (now - (buf.receivedAt || 0) > INCOMING_FILE_BUFFER_TTL_MS) {
      incomingFileBuffers.delete(id);
      // брошенный приём: сообщение не должно навсегда остаться «загружается»
      try {
        const c = buf.from && state.contacts.get(buf.from);
        const rec = c && c.messages.find((m) => m.id === id);
        if (rec && rec.file && rec.file.pending) { rec.file.pending = false; rec.file.failed = true; persistContacts(); if (state.chatId === buf.from) renderChatThread(); }
      } catch (e) {}
    }
  }
}
function handleFilePayload(from, payload) {
  if (payload.kind === "file-meta") {
    // Без верхней границы недобросовестный/сбойный пир мог прислать много
    // мелких file-meta и никогда не прислать file-done — Map росла бы
    // без предела. Также отклоняем заведомо нереалистичный totalChunks
    // (легитимный максимум — 2 МБ / 48 КБ ≈ 43 куска; 500 — с большим
    // запасом), чтобы не аллоцировать под него огромный массив заранее.
    const totalChunks = payload.totalChunks;
    if (!Number.isInteger(totalChunks) || totalChunks <= 0 || totalChunks > 500) return;
    // payload.size раньше сохранялся как есть, без проверки вообще —
    // отправляющая сторона (sendFileMessage) никогда не пропустит
    // файл больше MAX_FILE_SIZE, но НЕДОБРОСОВЕСТНЫЙ пир мог заявить
    // любой размер и следом прислать totalChunks (до 500) реальных
    // мегабайтных кусков — несоответствие size не проверялось вовсе,
    // только количество кусков. До ~500МБ на одну передачу,
    // MAX_INCOMING_FILE_TRANSFERS=20 одновременных — до ~10ГБ.
    if (!EtherFileLimits.isValidFileMetaSize(payload.size)) return;
    sweepIncomingFileBuffers();
    // Повторный file-meta (ретрай через сервер, fallback после P2P) —
    // не пересоздаём буфер и не дублируем сообщение.
    if (incomingFileBuffers.has(payload.id)) return;
    if (incomingFileBuffers.size >= MAX_INCOMING_FILE_TRANSFERS) return;
    // IDB-ключ вложения — только id сообщения: чужой id из другого чата принять нельзя (иначе подмена уже лежащего файла)
    for (const [oid, oc] of state.contacts) {
      if (oid !== from && oc.messages && oc.messages.some((m) => m.id === payload.id && m.file)) return;
    }
    {
      const existing = state.contacts.get(from);
      const prev = existing && existing.messages.find((m) => m.id === payload.id);
      if (prev) {
        // Приём брошенной (буфер вычищен по TTL) передачи, которую пир повторил:
        // заводим буфер заново, но сообщение не дублируем.
        if (prev.file && (prev.file.pending || prev.file.failed) && prev.from === "them") {
          if (prev.file.failed) { prev.file.failed = false; prev.file.pending = true; persistContacts(); }
          incomingFileBuffers.set(payload.id, { name: payload.name, mime: payload.mime, size: payload.size, totalChunks, chunks: new Array(totalChunks).fill(null), from, receivedAt: Date.now() });
        }
        return;
      }
    }
    incomingFileBuffers.set(payload.id, { name: payload.name, mime: payload.mime, size: payload.size, totalChunks, chunks: new Array(totalChunks).fill(null), from, receivedAt: Date.now() });
    const c = ensureContactEntry(from, null);
    const isOpen = state.chatId === from;
    const rec = { id: payload.id, from: "them", text: "", ts: Date.now(), readAckSent: false,
      file: { name: payload.name, mime: payload.mime, size: payload.size, kind: fileKindFromMime(payload.mime), duration: safeDuration(payload.duration), wave: sanitizeWave(payload.wave), pending: true } };
    if (safeTtl(payload.ttl)) rec.ttl = safeTtl(payload.ttl);
    if (payload.forwarded) { rec.forwarded = true; if (typeof payload.fwdFrom === "string" && payload.fwdFrom) rec.forwardedFrom = payload.fwdFrom.slice(0, 40); }
    if (typeof payload.caption === "string" && payload.caption) rec.file.caption = payload.caption.slice(0, 200);
    if (!rec.ttl && c.disappearingTimer) rec.ttl = c.disappearingTimer; // таймер исчезновения общий для чата — действует и на файлы
    c.messages.push(rec); trimMessages(c); c.lastActivity = Date.now(); persistContacts();
    if (isOpen) renderChatThread();
    if (state.tab === "chats") renderChatsList();
    return;
  }
  if (payload.kind === "file-chunk") {
    const buf = incomingFileBuffers.get(payload.id);
    if (!buf || buf.from !== from || payload.index == null || payload.index < 0 || payload.index >= buf.totalChunks) return;
    buf.receivedAt = Date.now();
    // Заявленный payload.size (проверен выше, при file-meta) — это
    // размер ИСХОДНОГО файла, а не то, сколько реально байт может
    // прийти в чанках: totalChunks сам по себе допускает до 500
    // кусков, и НИЧТО раньше не мешало прислать кусков суммарно
    // намного больше заявленного size (пир мог соврать в file-meta
    // про маленький размер, а потом закачать чанками мегабайты).
    // Считаем накопленный объём base64 и обрываем приём, если он
    // заметно превышает то, что даёт исходный size после base64
    // (~4/3) с разумным запасом.
    const chunkLen = typeof payload.data === "string" ? payload.data.length : 0;
    const alreadyReceived = buf.receivedBytes || 0;
    if (EtherFileLimits.chunkExceedsBudget(alreadyReceived, chunkLen, buf.size)) { incomingFileBuffers.delete(payload.id); return; }
    buf.receivedBytes = alreadyReceived + chunkLen;
    buf.chunks[payload.index] = payload.data;
    return;
  }
  if (payload.kind === "file-done") {
    const buf = incomingFileBuffers.get(payload.id);
    if (!buf || buf.from !== from) return;
    incomingFileBuffers.delete(payload.id);
    finishIncomingFile(payload.id, buf, from);
  }
}
async function finishIncomingFile(msgId, buf, from) {
  const c = state.contacts.get(from);
  const rec = c && c.messages.find((m) => m.id === msgId);
  if (buf.chunks.some((ch) => ch === null)) {
    // какой-то кусок не долетел — не собираем повреждённый файл
    if (rec) { rec.file.pending = false; rec.file.failed = true; persistContacts(); if (state.chatId === from) renderChatThread(); }
    return;
  }
  if (!rec || !rec.file || !rec.file.pending) return; // нет ожидающего сообщения именно в этом чате — ничего не пишем в IDB
  try {
    const byteArrays = buf.chunks.map(base64ToUint8Array);
    const blob = new Blob(byteArrays, { type: buf.mime });
    await IDB.set("file:" + msgId, blob);
  } catch (e) {
    if (rec) { rec.file.pending = false; rec.file.failed = true; persistContacts(); if (state.chatId === from) renderChatThread(); }
    return;
  }
  if (rec) {
    rec.file.pending = false;
    persistContacts();
    const isOpen = state.chatId === from;
    if (isOpen) { renderChatThread(); playMessageSound(from); vibrate([80, 40, 80]); }
    else {
      const label = T("chat.file.preview." + rec.file.kind);
      toast(`${c.name}: ${label}`);
      if (!isContactMuted(c)) showNotification(c.name || T("app.name"), label, { tag: "ether-msg-" + c.id, contactId: c.id, kind: "message", forceSilent: c.vibrateOnly });
      playMessageSound(from);
      vibrate([80, 40, 80]);
    }
    if (state.tab === "chats") renderChatsList();
    // «Прочитано» уходит только через markThreadRead (его вызывает renderChatThread, когда лента прокручена к низу) —
    // раньше здесь отправлялось безусловно, даже если человек листал старую переписку.
    updateAppBadge();
  }
}
// =====================================================================
// Полноэкранный просмотр медиа / меню для ссылок — открываются по
// обычному тапу на сообщении, в зависимости от типа содержимого
// (голосовое → воспроизведение, картинка/видео → во весь экран,
// ссылка → выбор действия). Долгое нажатие на ЛЮБОЕ сообщение по-
// прежнему открывает обычное меню (ответить/переслать/удалить и т.д.)
// — как в большинстве мессенджеров.
function openMediaViewer(url, kind) {
  const viewer = $("#media-viewer"); if (!viewer) return;
  const img = $("#media-viewer-img");
  const video = $("#media-viewer-video");
  if (kind === "video") {
    if (img) img.classList.add("hidden");
    if (video) { video.classList.remove("hidden"); video.src = url; video.play().catch(() => {}); }
  } else {
    if (video) { video.classList.add("hidden"); video.pause(); video.removeAttribute("src"); }
    if (img) { img.classList.remove("hidden"); img.src = url; }
  }
  __mediaViewerReturnFocus = document.activeElement;
  viewer.classList.remove("hidden");
  const closeBtn = $("#media-viewer-close"); if (closeBtn) closeBtn.focus();
}
let __mediaViewerReturnFocus = null;
function closeMediaViewer() {
  const viewer = $("#media-viewer"); if (!viewer) return;
  viewer.classList.add("hidden");
  const back = __mediaViewerReturnFocus; __mediaViewerReturnFocus = null;
  if (back && document.body.contains(back) && typeof back.focus === "function") { try { back.focus(); } catch (e) {} }
  const video = $("#media-viewer-video"); if (video) { video.pause(); video.removeAttribute("src"); }
  const img = $("#media-viewer-img"); if (img) img.removeAttribute("src");
}
// «К содержимому»: перенос фокуса на <main> без изменения адреса страницы (приложение читает hash для инвайтов)
function wireSkipLink() {
  const link = $(".skip-link"); if (!link || link.dataset.wired) return; link.dataset.wired = "1";
  link.addEventListener("click", (e) => { e.preventDefault(); const m = $("#content"); if (m) m.focus(); });
}
function wireMediaViewer() {
  const closeBtn = $("#media-viewer-close");
  if (closeBtn) closeBtn.addEventListener("click", closeMediaViewer);
  const viewer = $("#media-viewer");
  if (viewer) viewer.addEventListener("click", (ev) => { if (ev.target === viewer) closeMediaViewer(); });
  // Модальное окно: Esc закрывает, Tab не выходит за его пределы
  document.addEventListener("keydown", (e) => {
    const v = $("#media-viewer"); if (!v || v.classList.contains("hidden")) return;
    if (e.key === "Escape") { e.preventDefault(); closeMediaViewer(); return; }
    if (e.key !== "Tab") return;
    const items = focusableIn(v); if (items.length === 0) { e.preventDefault(); return; }
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || !v.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !v.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  });
}

let linkActionTargetUrl = "";
function openLinkActionSheet(url) {
  linkActionTargetUrl = url;
  const urlEl = $("#link-action-url"); if (urlEl) urlEl.textContent = url;
  const sheet = $("#link-action-sheet"); if (sheet) sheet.classList.remove("hidden");
}
function wireLinkActionSheet() {
  const openBtn = $("#link-action-open");
  if (openBtn) openBtn.addEventListener("click", () => {
    const sheet = $("#link-action-sheet"); if (sheet) sheet.classList.add("hidden");
    if (linkActionTargetUrl && /^https?:\/\//i.test(linkActionTargetUrl)) window.open(linkActionTargetUrl, "_blank", "noopener,noreferrer");
  });
  const copyBtn = $("#link-action-copy");
  if (copyBtn) copyBtn.addEventListener("click", async () => {
    const sheet = $("#link-action-sheet"); if (sheet) sheet.classList.add("hidden");
    try { await navigator.clipboard.writeText(linkActionTargetUrl); toast(T("toast.linkCopied")); } catch (e) {}
  });
}

// Переиспользуемое воспроизведение голосового — раньше плей-кнопка сама
// заводила <audio> и слушала клик только на СЕБЕ, а тап по всему пузырю
// (за пределами кнопки) уходил в общий обработчик и открывал меню
// сообщения ОДНОВРЕМЕННО с воспроизведением. Теперь голосовые элементы
// (созданные в hydrateFileSlots) хранят свой <audio> прямо на DOM-узле
// пузыря — эта функция находит его и дёргает тот же toggle.
function toggleVoicePlaybackFor(bubbleEl) {
  const btn = bubbleEl.querySelector(".voice-play-btn");
  if (btn && !btn.disabled) btn.click();
}
async function getFileBlobUrl(msgId) {
  if (fileBlobUrlCache.has(msgId)) return fileBlobUrlCache.get(msgId);
  const blob = await IDB.get("file:" + msgId);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  fileBlobUrlCache.set(msgId, url);
  if (fileBlobUrlCache.size > FILE_BLOB_URL_CACHE_MAX) {
    const toRemove = fileBlobUrlCache.size - Math.floor(FILE_BLOB_URL_CACHE_MAX * 0.9);
    let removed = 0;
    for (const [k, u] of fileBlobUrlCache) {
      if (removed >= toRemove) break;
      // Раньше вытеснение шло вслепую по возрасту записи — если URL в
      // этот момент реально отображается в DOM (<img>/<video> в открытом
      // чате), revokeObjectURL() ломает уже показанную картинку (у
      // пользователя с длинной перепиской с фото это выглядело как
      // внезапно пропавшее превью). Пропускаем то, что сейчас на экране,
      // и вытесняем следующую по возрасту запись вместо неё.
      if (document.querySelector(`[data-file-id="${CSS.escape(k)}"]`)) continue;
      URL.revokeObjectURL(u);
      fileBlobUrlCache.delete(k);
      removed++;
    }
  }
  return url;
}
function mediaTagHtml(kind, url) {
  return kind === "video"
    ? `<video src="${escapeHtml(url)}#t=0.1" controls playsinline preload="metadata"></video>`
    : `<img src="${escapeHtml(url)}" alt="" decoding="async" />`;
}
// Запоминаем реальные пропорции медиа — при следующих отрисовках слот сразу нужного размера
function rememberMediaSize(msgId, w, h) {
  if (!w || !h) return;
  for (const c of state.contacts.values()) {
    const m = c.messages.find((x) => x.id === msgId);
    if (m && m.file && !m.file.w) { m.file.w = w; m.file.h = h; return; }
  }
}
function fileBubbleHtml(msgId, fileInfo) {
  if (fileInfo.pending) {
    // Если известен точный прогресс (живая P2P-передача даёт его через
    // onProgress в sendFile) — показываем честный процент. Если нет
    // (офлайн-путь через почтовый ящик сервера, где файл уходит одним
    // payload без чанкования) — бегущая полоска без цифр, чтобы не
    // врать нулём или вечными 0%.
    const bar = typeof fileInfo.progress === "number"
      ? `<div class="file-progress"><div class="file-progress-fill" style="width:${(fileInfo.progress * 100).toFixed(1)}%"></div></div>`
      : `<div class="file-progress-indeterminate"></div>`;
    return `<div class="file-bubble file-bubble-pending" data-msg-id="${escapeHtml(msgId)}"><div class="file-spinner"></div><span>${escapeHtml(T("chat.file.sending"))}</span>${bar}</div>`;
  }
  if (fileInfo.failed) {
    return `<div class="file-bubble file-bubble-failed">${Icons.html("warning", 16)} <span>${escapeHtml(T("chat.file.failed"))}</span></div>`;
  }
  const sizeStr = formatFileSize(fileInfo.size);
  // Подпись (P1.12) — под медиа-слотом, отдельной строкой. Применима к
  // фото/видео (где и есть кнопка "Превью с подписью" при отправке);
  // для голосовых/документов caption в UI пока не предлагается, но
  // если пришла (например, от будущей версии клиента) — тоже покажем.
  const captionHtml = fileInfo.caption ? `<div class="file-caption">${escapeHtml(fileInfo.caption)}</div>` : "";
  if (fileInfo.kind === "image" || fileInfo.kind === "video") {
    // Место под медиа резервируется сразу (известные пропорции или 4:3 / 16:9 по умолчанию), а уже загруженный blob-URL
    // подставляется синхронно — иначе список «прыгал» при каждой перерисовке и подгрузке картинок/видео.
    const ar = (fileInfo.w && fileInfo.h) ? (fileInfo.w + " / " + fileInfo.h) : (fileInfo.kind === "video" ? "16 / 9" : "4 / 3");
    const cached = fileBlobUrlCache.get(msgId);
    const inner = cached ? mediaTagHtml(fileInfo.kind, cached) : `<div class="file-media-loading">${escapeHtml(T("chat.file.loading"))}</div>`;
    return `<div class="file-media-wrap"><div class="file-media-slot" style="aspect-ratio:${ar}" data-file-id="${escapeHtml(msgId)}" data-file-kind="${fileInfo.kind}">${inner}</div>${captionHtml}</div>`;
  }
  if (fileInfo.kind === "audio") {
    const durLabel = fileInfo.duration ? formatVoiceDuration(fileInfo.duration) : "";
    // .voice-live-wave — раздел 7 роадмапа, "real waveform ПРИ ПРОСЛУШИВАНИИ
    // у всех участников" (не путать с V.45.0.0 — там же про запись). 5
    // столбиков, без анимации в разметке — высота/прозрачность управляются
    // инлайн-стилями из JS (см. startVoicePlaybackWaveLoop), ровно как у
    // уже существующей волны записи (#voice-recording-bar), просто
    // применительно к AnalyserNode на MediaElementSource воспроизводимого
    // <audio>, а не на живом микрофонном MediaStream.
    return `<div class="voice-bubble" data-file-id="${escapeHtml(msgId)}" data-file-kind="audio" data-duration="${safeDuration(fileInfo.duration)}">
      <button type="button" class="voice-play-btn" disabled><span class="vp-ico">${VOICE_PLAY_ICON_SVG()}</span></button>
      <span class="voice-live-wave" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></span>
      <div class="voice-progress voice-wave" role="slider" tabindex="0" aria-label="${escapeHtml(T("chat.voice.seek"))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="voice-wave-bars">${voiceWaveHtml(fileInfo.wave, msgId)}</div><div class="voice-progress-fill"></div></div>
      <button type="button" class="voice-speed-btn" aria-label="${escapeHtml(T("chat.voice.speed"))}">${voiceSpeed()}×</button>
      <button type="button" class="voice-tr-btn" aria-label="${escapeHtml(T("ai.transcribe"))}" title="${escapeHtml(T("ai.transcribe"))}">${Icons.html("text", 16)}</button>
      <span class="voice-duration">${escapeHtml(durLabel)}</span>
      ${fileInfo.transcript ? `<div class="voice-transcript">${escapeHtml(typeof LocalAI !== "undefined" ? LocalAI.cleanTranscript(fileInfo.transcript) : fileInfo.transcript)}</div>` : ""}
    </div>`;
  }
  return `<a class="file-bubble file-bubble-doc" data-file-id="${escapeHtml(msgId)}" data-file-kind="file" data-file-name="${escapeHtml(fileInfo.name || "file")}" href="#">
    <span class="file-doc-icon"><svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm8 1.5V8h4.5L14 3.5zM7 12h10v1.5H7V12zm0 4h10v1.5H7V16zm0-8h5v1.5H7V8z"/></svg></span>
    <span class="file-doc-info"><span class="file-doc-name">${escapeHtml(fileInfo.name)}</span><span class="file-doc-size">${escapeHtml(sizeStr)}</span></span>
  </a>`;
}
// Форма волны голосового: до 64 целых 0..31 — считается при записи, едет в метаданных вместе с duration. Чужое значение чистим.
// Числовые поля из чужих данных (длительность, таймер): только конечные неотрицательные числа в разумных пределах
// Время сообщения от собеседника: конечное число не из далёкого будущего (иначе сообщение «прилипнет» к низу ленты, а его заметка/доска
// получит метку времени, которую уже никто не сможет перебить)
// Часы LWW (poll-vote / note-op / board-op): берём время ОТПРАВИТЕЛЯ (оффлайн-доставка бывает через дни — время получения исказило бы порядок правок),
// но не позже времени получения + допуск на расхождение часов (OP_TS_SKEW_MS): иначе правка с ts «из будущего» навсегда выигрывала бы у всех честных.
// Не число / нет ts → время получения. Слишком старое (старше срока хранения ящика) → тоже время получения, чтобы «ts: 1» не терял честные правки.
const OP_TS_SKEW_MS = 30000, OP_TS_MAX_AGE_MS = 15 * 86400000;
function clampOpTs(claimed, receivedAt) {
  const now = Number.isFinite(receivedAt) ? receivedAt : Date.now();
  const n = Number(claimed);
  if (!Number.isFinite(n) || n <= 0 || n < now - OP_TS_MAX_AGE_MS) return now;
  return Math.min(n, now + OP_TS_SKEW_MS);
}
function safeMsgTs(v) { const n = Number(v), now = Date.now(); return Number.isFinite(n) && n > now - 400 * 86400000 && n <= now + 5 * 60000 ? n : now; }
function safeDuration(v) { const n = Number(v); return Number.isFinite(n) && n >= 0 && n < 86400 ? n : 0; }
function safeTtl(v) { const n = Number(v); return Number.isFinite(n) && n >= 1000 && n <= 400 * 86400000 ? n : 0; }
const VOICE_WAVE_BARS = 40;
function sanitizeWave(w) {
  if (!Array.isArray(w) || w.length < 4 || w.length > 64) return undefined;
  const out = w.map((v) => Math.max(0, Math.min(31, Math.round(Number(v) || 0))));
  return out;
}
function compressWave(samples, n) {
  n = n || VOICE_WAVE_BARS;
  if (!samples || samples.length < 2) return undefined;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * samples.length / n), b = Math.max(a + 1, Math.floor((i + 1) * samples.length / n));
    let mx = 0; for (let j = a; j < b && j < samples.length; j++) if (samples[j] > mx) mx = samples[j];
    out.push(mx);
  }
  const peak = Math.max(...out, 0.02);
  return out.map((v) => Math.max(2, Math.round((v / peak) * 31)));
}
// Когда волна не пришла (старый клиент) — ровные «псевдослучайные» столбики от id сообщения, чтобы дорожка не была пустой
function fallbackWave(seed) {
  let h = 2166136261; for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  const out = []; for (let i = 0; i < VOICE_WAVE_BARS; i++) { h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0; out.push(6 + (h % 14)); }
  return out;
}
function voiceWaveHtml(wave, seed) {
  const w = sanitizeWave(wave) || fallbackWave(seed || "x");
  return w.map((v) => `<i style="height:${Math.round(18 + (v / 31) * 82)}%"></i>`).join("");
}
// У голосовых от старых клиентов волны нет — считаем её один раз из самого звука (локально) и запоминаем в сообщении.
const waveBackfillTried = new Set();
async function backfillVoiceWave(msgId, el) {
  if (waveBackfillTried.has(msgId)) return;
  waveBackfillTried.add(msgId);
  let m = null;
  for (const c of state.contacts.values()) { m = (c.messages || []).find((x) => x.id === msgId); if (m) break; }
  if (!m || !m.file || m.file.wave) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const blob = await IDB.get("file:" + msgId);
    if (!AC || !blob || blob.size > 4 * 1024 * 1024) return;
    const ctx = new AC(); let audio;
    try { audio = await ctx.decodeAudioData(await blob.arrayBuffer()); } finally { try { ctx.close(); } catch (e) {} }
    const data = audio.getChannelData(0), n = Math.min(data.length, 200000), step = Math.max(1, Math.floor(data.length / n));
    const abs = new Float32Array(Math.ceil(data.length / step));
    for (let i = 0, k = 0; i < data.length; i += step, k++) abs[k] = Math.abs(data[i]);
    const wave = sanitizeWave(compressWave(abs));
    if (!wave) return;
    m.file.wave = wave;
    persistContacts();
    const bars = el && el.querySelector(".voice-wave-bars");
    if (bars) bars.innerHTML = voiceWaveHtml(wave, msgId);
  } catch (e) { /* формат не декодируется — остаётся условная волна */ }
}
const VOICE_SPEEDS = [1, 1.5, 2];
function voiceSpeed() { let v = 1; try { v = parseFloat(localStorage.getItem("ether.voiceSpeed")) || 1; } catch (e) {} return VOICE_SPEEDS.includes(v) ? v : 1; }
function cycleVoiceSpeed() {
  const next = VOICE_SPEEDS[(VOICE_SPEEDS.indexOf(voiceSpeed()) + 1) % VOICE_SPEEDS.length];
  try { localStorage.setItem("ether.voiceSpeed", String(next)); } catch (e) {}
  document.querySelectorAll(".voice-speed-btn").forEach((b) => { b.textContent = next + "×"; });
  for (const e of voiceAudioCache.values()) { try { e.audio.playbackRate = next; } catch (x) {} }
  return next;
}
function formatVoiceDuration(sec) {
  // floor, не round: 59.6с реально длится 59.6с — round дал бы "1:00",
  // хотя запись ещё не дотянула до минуты. Для таймера записи и длины
  // готового голосового это обманывает пользователя в большую сторону.
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + ":" + String(s).padStart(2, "0");
}
// Единая иконография — play/pause голосового сообщения раньше были
// текстовыми символами ▶/⏸ (textContent), теперь те же SVG, что и
// везде в приложении (viewBox 24×24, currentColor).
const VOICE_PLAY_ICON_SVG = () => Icons.html("play", 16); // функция: иконки скина (skins.js) грузятся позже app.js
// Значок play/pause живёт в своём <span class="vp-ico"> — рисунок кассеты/пластинки (features.js) лежит рядом в той же кнопке и не затирается
function setVoiceIcon(btn, svg) {
  if (!btn) return;
  let ico = btn.querySelector(".vp-ico");
  if (!ico) { ico = document.createElement("span"); ico.className = "vp-ico"; btn.appendChild(ico); }
  ico.innerHTML = svg;
}
const VOICE_PAUSE_ICON_SVG = () => Icons.html("pause", 16);
const voiceAudioCache = new Map(); // msgId -> { audio, playing, analyser? } — переиспользуем между рендерами
// Раньше при уходе из чата (в список чатов или в другой чат) голосовое,
// если оно играло, продолжало звучать в фоне — кнопки для остановки
// уже не было, а сам Audio() из кеша никто не ставил на паузу.
function pauseAllVoicePlayback() {
  for (const entry of voiceAudioCache.values()) {
    if (entry.playing) { entry.audio.pause(); entry.playing = false; }
  }
  document.querySelectorAll(".voice-play-btn").forEach((b) => { setVoiceIcon(b, VOICE_PLAY_ICON_SVG()); });
  stopVoicePlaybackWaveLoop();
  clearNowPlaying();
}
// === Раздел 7 роадмапа — real waveform ПРИ ПРОСЛУШИВАНИИ голосовых (а не
// только при их записи, см. V.45.0.0 startVoiceLevelMeter/AnalyserNode на
// микрофонном MediaStream — здесь тот же приём, но источник — уже
// ЗАПИСАННЫЙ и воспроизводимый <audio>, то есть работает у ЛЮБОГО
// участника переписки, который слушает голосовое, не только у того, кто
// его записывал). ===
// Один общий AudioContext на все голосовые — отдельный контекст на каждое
// сообщение был бы расточительным (и часть браузеров ограничивает их
// количество на странице).
let __voicePlaybackCtx = null;
function getVoicePlaybackAudioCtx() {
  if (__voicePlaybackCtx) return __voicePlaybackCtx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    __voicePlaybackCtx = new AC();
  } catch (e) { return null; }
  return __voicePlaybackCtx;
}
let __voiceWaveRaf = null;
let __voiceWaveLastSampleAt = 0;
let __voiceWaveHistory = [0, 0, 0, 0, 0];
function resetVoiceWaveBars() {
  document.querySelectorAll(".voice-live-wave span").forEach((b) => { b.style.transform = ""; b.style.opacity = ""; });
}
// Один rAF-цикл на всё приложение (а не по циклу на голосовое) — голосовые
// и так проигрываются по одному за раз (см. "не играть несколько хором"
// в hydrateFileSlots), так что достаточно на каждый тик найти ТО единственное
// играющее сообщение и обновить именно его столбики. DOM-узлы бара ищутся
// заново на каждый тик (не кешируются) — после ре-рендера чата старые
// ссылки на .voice-live-wave были бы мёртвыми, а голосовое могло продолжать
// играть через уже пересозданную разметку.
function startVoicePlaybackWaveLoop() {
  if (__voiceWaveRaf) return;
  const tick = (now) => {
    __voiceWaveRaf = requestAnimationFrame(tick);
    let playingMsgId = null, playingEntry = null;
    for (const [id, entry] of voiceAudioCache) {
      if (entry.playing) { playingMsgId = id; playingEntry = entry; break; }
    }
    if (!playingEntry || !playingEntry.analyser) { resetVoiceWaveBars(); return; }
    if (now - __voiceWaveLastSampleAt < 90) return; // ~11 замеров/сек, как и у волны записи — getByteTimeDomainData+DOM не нужно гонять на каждый из 60 кадров/сек
    __voiceWaveLastSampleAt = now;
    if (!playingEntry.waveformData) playingEntry.waveformData = new Uint8Array(playingEntry.analyser.fftSize);
    playingEntry.analyser.getByteTimeDomainData(playingEntry.waveformData);
    let sumSq = 0;
    for (let i = 0; i < playingEntry.waveformData.length; i++) { const v = (playingEntry.waveformData[i] - 128) / 128; sumSq += v * v; }
    const rms = Math.sqrt(sumSq / playingEntry.waveformData.length);
    __voiceWaveHistory.push(rms);
    __voiceWaveHistory.shift();
    const bars = document.querySelectorAll(`.voice-bubble[data-file-id="${CSS.escape(playingMsgId)}"] .voice-live-wave span`);
    bars.forEach((b, i) => {
      const level = Math.min(1, __voiceWaveHistory[i] * 3.5);
      b.style.transform = `scaleY(${(0.4 + level * 1.1).toFixed(2)})`;
      b.style.opacity = (0.4 + level * 0.6).toFixed(2);
    });
  };
  __voiceWaveRaf = requestAnimationFrame(tick);
}
function stopVoicePlaybackWaveLoop() {
  if (__voiceWaveRaf) { cancelAnimationFrame(__voiceWaveRaf); __voiceWaveRaf = null; }
  __voiceWaveHistory = [0, 0, 0, 0, 0];
  resetVoiceWaveBars();
}
// Останавливает цикл ТОЛЬКО если вообще никто больше не играет — вызывается
// после паузы/окончания одного голосового, когда в принципе мог начать
// играть другое (хотя в этом приложении одновременно играет не больше
// одного — проверка на всякий случай, дешевле, чем предполагать).
function stopVoicePlaybackWaveLoopIfIdle() {
  for (const entry of voiceAudioCache.values()) if (entry.playing) return;
  stopVoicePlaybackWaveLoop();
}
function hydrateFileSlots(root) {
  root.querySelectorAll(".file-media-slot[data-file-id], .file-bubble-doc[data-file-id]").forEach((el) => {
    const msgId = el.getAttribute("data-file-id");
    const kind = el.getAttribute("data-file-kind");
    getFileBlobUrl(msgId).then((url) => {
      if (!url) {
        if (typeof Devices !== "undefined" && Devices.stubFile(el, msgId)) return; // файл остался на другом устройстве аккаунта: кнопка «Запросить»
        // Раньше при неудаче (файл не докачан/удалён/ошибка IDB) слот
        // так и оставался с "Загрузка…" навсегда — пользователь не мог
        // понять, что происходит.
        const loadingEl = el.querySelector(".file-media-loading");
        if (loadingEl) loadingEl.textContent = T("chat.file.unavailable");
        else if (el.classList.contains("file-bubble-doc")) el.textContent = T("chat.file.unavailable");
        return;
      }
      if (kind === "image" || kind === "video") {
        if (!el.querySelector("img, video")) el.innerHTML = mediaTagHtml(kind, url);
        const mediaEl = el.querySelector("img, video");
        if (mediaEl) {
          const onSize = () => rememberMediaSize(msgId, mediaEl.naturalWidth || mediaEl.videoWidth, mediaEl.naturalHeight || mediaEl.videoHeight);
          mediaEl.addEventListener(kind === "video" ? "loadedmetadata" : "load", onSize, { once: true });
          if (kind === "image" && mediaEl.complete) onSize();
        }
      }
      else if (kind === "file") { el.href = url; el.setAttribute("download", (el.getAttribute("data-file-name") || "file").replace(/[\/\\]/g, "_").slice(0, 120)); }
    }).catch(() => {
      const loadingEl = el.querySelector(".file-media-loading");
      if (loadingEl) loadingEl.textContent = T("chat.file.unavailable");
    });
  });
  root.querySelectorAll(".voice-bubble[data-file-id]").forEach((el) => {
    const msgId = el.getAttribute("data-file-id");
    const playBtn = el.querySelector(".voice-play-btn");
    const fill = el.querySelector(".voice-progress-fill");
    const durEl = el.querySelector(".voice-duration");
    const knownDuration = parseFloat(el.getAttribute("data-duration")) || 0;
    const speedBtn0 = el.querySelector(".voice-speed-btn");
    if (speedBtn0) speedBtn0.onclick = (ev) => { ev.stopPropagation(); cycleVoiceSpeed(); };
    const trBtn0 = el.querySelector(".voice-tr-btn");
    if (trBtn0) trBtn0.onclick = (ev) => { ev.stopPropagation(); if (typeof transcribeVoiceMessage === "function" && state.chatId) transcribeVoiceMessage(state.chatId, msgId); };
    backfillVoiceWave(msgId, el);
    getFileBlobUrl(msgId).then((url) => {
      if (!url || !playBtn) {
        if (!url && typeof Devices !== "undefined" && Devices.stubFile(el, msgId)) return;
        // Та же проблема для голосовых — кнопка play оставалась
        // disabled навсегда без единого объяснения.
        if (durEl) durEl.textContent = T("chat.file.unavailable");
        return;
      }
      // Раньше тут создавался НОВЫЙ Audio() на каждый рендер чата (wrap.innerHTML
      // пересобирает DOM целиком при любом новом сообщении) — старый объект,
      // если в этот момент играл, продолжал играть в фоне без возможности
      // остановить (кнопка/обработчики принадлежали уже уничтоженному узлу).
      // Кешируем по msgId и переиспользуем один и тот же Audio между рендерами,
      // перепривязывая обработчики к актуальным (пересозданным) DOM-элементам.
      let entry = voiceAudioCache.get(msgId);
      if (!entry) {
        entry = { audio: new Audio(url), playing: false };
        voiceAudioCache.set(msgId, entry);
        // Воспроизведение — обычный <audio> напрямую, без Web Audio: раньше звук шёл через MediaElementSource в
        // AudioContext, который стартует «suspended», и первое нажатие молчало (приходилось жать второй раз).
        // fileBlobUrlCache и linkPreviewCache уже ограничены по размеру,
        // а voiceAudioCache — нет: рос на каждый когда-либо проигранный
        // голосовой за сессию, чистился только при удалении сообщения.
        // За долгую активную переписку с голосовыми — сотни живых
        // HTMLAudioElement. Вытесняем только НЕ играющие сейчас записи.
        if (voiceAudioCache.size > 200) {
          const toRemove = voiceAudioCache.size - 180;
          let removed = 0;
          for (const [k, v] of voiceAudioCache) {
            if (removed >= toRemove) break;
            if (v.playing) continue; // не вытесняем то, что сейчас реально играет
            try { v.audio.pause(); } catch (e) {}
            voiceAudioCache.delete(k);
            removed++;
          }
        }
      }
      const audio = entry.audio;
      playBtn.disabled = false;
      setVoiceIcon(playBtn, entry.playing ? VOICE_PAUSE_ICON_SVG() : VOICE_PLAY_ICON_SVG());
      el.classList.toggle("fx-playing", !!entry.playing);
      el.classList.toggle("is-playing", !!entry.playing);
      const durOf = () => (isFinite(audio.duration) && audio.duration > 0) ? audio.duration : knownDuration;
      const setUi = (playing) => {
        entry.playing = playing;
        setVoiceIcon(playBtn, playing ? VOICE_PAUSE_ICON_SVG() : VOICE_PLAY_ICON_SVG());
        el.classList.toggle("fx-playing", playing); el.classList.toggle("is-playing", playing);
      };
      // ontimeupdate/onended/onplay/onpause — присвоение свойств: ЗАМЕНЯЕТ обработчики прошлого рендера, а не копит дубли.
      const waveEl = el.querySelector(".voice-wave"), waveBars = waveEl ? Array.from(waveEl.querySelectorAll("i")) : [];
      const paintWave = (ratio) => {
        const n = Math.round(ratio * waveBars.length);
        waveBars.forEach((b, i) => b.classList.toggle("on", i < n));
        if (waveEl) waveEl.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
      };
      const applySpeed = () => { try { audio.playbackRate = voiceSpeed(); audio.preservesPitch = true; } catch (e) {} };
      // Перемотка по волне: тап — прыжок, перетаскивание — скраббинг; со стрелок клавиатуры ±5 с
      const seekTo = (ratio) => {
        const dur = durOf(); if (!dur) return;
        ratio = Math.max(0, Math.min(1, ratio));
        try { audio.currentTime = ratio * dur; } catch (e) {}
        paintWave(ratio); if (fill) fill.style.width = (ratio * 100) + "%";
        if (durEl) durEl.textContent = formatVoiceDuration(Math.max(0, dur - ratio * dur));
      };
      if (waveEl) {
        const ratioAt = (ev) => { const r = waveEl.getBoundingClientRect(); const x = (ev.clientX - r.left) / (r.width || 1); return getComputedStyle(waveEl).direction === "rtl" ? 1 - x : x; };
        let dragging = false;
        waveEl.onpointerdown = (ev) => { ev.stopPropagation(); dragging = true; try { waveEl.setPointerCapture(ev.pointerId); } catch (e) {} seekTo(ratioAt(ev)); };
        waveEl.onpointermove = (ev) => { if (dragging) seekTo(ratioAt(ev)); };
        waveEl.onpointerup = waveEl.onpointercancel = () => { dragging = false; };
        waveEl.onclick = (ev) => ev.stopPropagation();
        waveEl.onkeydown = (ev) => {
          if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
          ev.preventDefault(); const dur = durOf(); if (!dur) return;
          const d = (ev.key === "ArrowRight" ? 5 : -5) * (getComputedStyle(waveEl).direction === "rtl" ? -1 : 1);
          seekTo((audio.currentTime + d) / dur);
        };
      }
      audio.ontimeupdate = () => {
        const dur = durOf();
        if (dur) paintWave(Math.min(1, audio.currentTime / dur));
        if (fill && dur) fill.style.width = Math.min(100, (audio.currentTime / dur) * 100) + "%";
        if (durEl && dur) durEl.textContent = formatVoiceDuration(Math.max(0, dur - audio.currentTime));
      };
      audio.onplay = () => setUi(true);
      audio.onpause = () => setUi(false);
      audio.onended = () => {
        setUi(false); clearNowPlaying();
        // Стопкой: после входящего голосового само запускается следующее входящее ниже по ленте
        try {
          if (el.closest(".bubble-row") && !el.closest(".bubble-row.mine")) {
            const all = Array.from(document.querySelectorAll("#chat-messages .bubble-row:not(.mine) .voice-bubble"));
            const next = all[all.indexOf(el) + 1];
            const nb = next && next.querySelector(".voice-play-btn:not([disabled])");
            if (nb) setTimeout(() => nb.click(), 250);
          }
        } catch (e) {}
        try { audio.currentTime = 0; } catch (e) {} // следующее прослушивание — всегда с начала
        if (fill) fill.style.width = "0%";
        paintWave(0);
        if (durEl) durEl.textContent = formatVoiceDuration(knownDuration || durOf() || 0);
      };
      if (audio.currentTime > 0.05) audio.ontimeupdate(); // перерисовка чата не должна сбрасывать показ позиции
      playBtn.onclick = (ev) => {
        if (ev) { ev.stopPropagation(); }
        // Не играть несколько голосовых хором — только через собственный кеш (эти Audio() не лежат в DOM).
        for (const [otherId, other] of voiceAudioCache) {
          if (otherId !== msgId && other.playing) { try { other.audio.pause(); } catch (e) {} }
        }
        if (!audio.paused) { audio.pause(); return; }
        // Закончившееся (или записанное MediaRecorder'ом без длительности в заголовке) голосовое играем с начала
        if (audio.ended || (isFinite(audio.duration) && audio.currentTime >= audio.duration - 0.05)) { try { audio.currentTime = 0; } catch (e) {} }
        applySpeed();
        audio.play().catch(() => { setUi(false); });
      };
    });
  });
}

function cleanupExpiredFileBlobs(removedMessages) {
  for (const m of removedMessages) {
    if (!m.file && !(m.sticker && m.sticker.custom)) continue; // B14: блобы своих стикеров (sticker.custom) тоже лежат в IDB под file:<id>
    IDB.del("file:" + m.id).catch(() => {});
    const url = fileBlobUrlCache.get(m.id);
    if (url) { URL.revokeObjectURL(url); fileBlobUrlCache.delete(m.id); }
    const cached = voiceAudioCache.get(m.id);
    if (cached) { try { cached.audio.pause(); } catch (e) {} voiceAudioCache.delete(m.id); }
  }
}
// Поле ввода растёт по тексту (до max-height в CSS): многострочные сообщения.
function autoGrowChatInput() {
  const el = $("#chat-input"); if (!el || el.tagName !== "TEXTAREA") return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight + 2, 132) + "px";
}
// Десктоп: Enter отправляет, Shift+Enter переносит строку. На сенсорных устройствах Enter всегда переносит строку (отправка — кнопкой).
function wireChatInputKeys() {
  const el = $("#chat-input"); if (!el || el.dataset.keysWired) return; el.dataset.keysWired = "1";
  el.addEventListener("input", autoGrowChatInput);
  // Программная подстановка текста (черновик, правка, очистка после отправки) тоже пересчитывает высоту
  try {
    const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
    if (desc && desc.set) Object.defineProperty(el, "value", { configurable: true, get() { return desc.get.call(this); }, set(v) { desc.set.call(this, v); autoGrowChatInput(); } });
  } catch (e) {}
  el.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229 || e.ctrlKey || e.altKey || e.metaKey) return;
    const coarse = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
    if (coarse) return;
    e.preventDefault();
    const form = $("#chat-form");
    if (form && el.value.trim()) { if (form.requestSubmit) form.requestSubmit(); else form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true })); }
  });
}
function updateSendVsMic() {
  const input = $("#chat-input"); if (!input) return;
  autoGrowChatInput();
  const hasText = input.value.trim().length > 0;
  const sendBtn = $(".send-btn[type=submit]");
  const micBtn = $("#voice-record-btn");
  const c = state.chatId ? state.contacts.get(state.chatId) : null;
  const inGroup = !!(c && isGroup(c));
  const writeBlocked = inGroup && !isGroupWriteAllowed(c, Store.myId);
  if (sendBtn) sendBtn.classList.toggle("hidden", !hasText || writeBlocked);
  // Голосовые сообщения не поддерживаются в группах — кнопка микрофона
  // не должна становиться видимой даже при пустом поле ввода. Также
  // скрыта, если писать в группу запрещено ("только админы").
  if (micBtn) micBtn.classList.toggle("hidden", hasText || writeBlocked);
}
// Исчезающие сообщения: таймер идёт от ПРОЧТЕНИЯ (как в Signal), а не от отправки — иначе непрочитанное успевало пропасть, так и не увидев.
// expAt ставится в момент прочтения (входящее — когда вы его увидели; исходящее — когда собеседник подтвердил «прочитано»).
// Непрочитанное хранится не дольше 30 суток. Старые сообщения без expAt, уже прочитанные, живут по прежнему правилу (от отправки).
const UNREAD_TTL_CAP_MS = 30 * 24 * 3600e3;
function msgExpiresAt(m) {
  if (!m || !m.ttl) return Infinity;
  if (m.expAt) return m.expAt;
  const read = m.from === "them" ? !!m.readAckSent : m.ack === "read";
  return read ? m.ts + m.ttl : m.ts + Math.max(m.ttl, UNREAD_TTL_CAP_MS);
}
function isMsgExpired(m, now) { return (now || Date.now()) > msgExpiresAt(m); }
function startExpiryOnRead(m) { if (m && m.ttl && !m.expAt) m.expAt = Date.now() + m.ttl; }
function sweepExpiredMessages() {
  const now = Date.now();
  let anyChanged = false;
  for (const c of state.contacts.values()) {
    const expired = c.messages.filter((m) => isMsgExpired(m, now));
    if (expired.length === 0) continue;
    cleanupExpiredFileBlobs(expired);
    c.messages = c.messages.filter((m) => !isMsgExpired(m, now));
    anyChanged = true;
  }
  if (!anyChanged) return;
  persistContacts();
  if (state.chatId) renderChatThread();
  if (state.tab === "chats") renderChatsList();
}

