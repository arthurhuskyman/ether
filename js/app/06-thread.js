"use strict";
// Часть 6 из 14 бывшего js/app.js: Тред чата (рендер, меню, палитра, истории, опросы). Глобальная область общая; порядок <script> важен.

// =====================================================================
// Тред
// =====================================================================
function ackGlyph(ack) {
  // 5 состояний на основе единой SVG-формы (Вариант B — «Эфирная
  // прогрессия»). Отличие от старой версии: не текст-символы ✓/◷/!,
  // а тонкие SVG-галочки — одинаковый размер во всех состояниях,
  // никакой зависимости от -webkit-text-stroke. Различие между
  // состояниями — через opacity, толщину обводки и цвет:
  //   pending   — пульсирующая точка 4px (рисуется CSS ::before)
  //   sent      — одна галочка, 55% opacity
  //   delivered — две галочки, 55% opacity
  //   read      — две галочки, 100% белый + белое свечение
  //   failed    — «!» в тонком контуре круга, красный
  // Вторая галочка выезжает справа через CSS-анимацию.
  const lbl = (k) => `role="img" aria-label="${escapeHtml(T("ack." + k))}"`;
  const tick = `<svg class="ack-svg" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M2 7.5 L5.2 10.7 L12 3"/></svg>`;
  const tick2 = `<svg class="ack-svg ack-svg-2" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M2 7.5 L5.2 10.7 L12 3"/></svg>`;

  if (ack === "failed") {
    return `<span class="ack-tick ack-failed" ${lbl("failed")} data-retry="1"><svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="5.8" fill="none" stroke="currentColor" stroke-width="1.5"/><path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" d="M7 3.6 V7.4 M7 10 V10.5"/></svg></span>`;
  }
  if (ack === "read")      return `<span class="ack-tick ack-read" ${lbl("read")}>${tick}${tick2}</span>`;
  if (ack === "delivered") return `<span class="ack-tick ack-delivered" ${lbl("delivered")}>${tick}${tick2}</span>`;
  if (ack === "pending")   return `<span class="ack-tick ack-pending" ${lbl("pending")}></span>`;
  return `<span class="ack-tick ack-sent" ${lbl("sent")}>${tick}</span>`;
}

const NEAR_BOTTOM_PX = 80;
function isNearBottom(el) { if (!el) return true; return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX; }

function renderChatHeaderSoft() { renderChatThreadInner(); } // шапка обновляется до проверки «подписи» ленты, поэтому ленту это не перестраивает
function renderChatThread() { try { renderKeyChangeBanner(); renderChatThreadInner(); if (state.threadRoot) renderThreadSheet(); if (typeof roomRenderBar === "function") roomRenderBar(); } catch (e) { __lastChatSig = ""; etherLog("error", "[renderChatThread]", String(e)); const w = $("#chat-messages"); if (w) w.innerHTML = `<div class="empty-state"><p>Error.</p></div>`; } }

let __lastChatSig = "";
const __renderedAck = new Map(); // id сообщения -> статус доставки на прошлой отрисовке (для анимации смены)
// «Подпись» содержимого переписки: если с прошлой отрисовки ничего видимого не изменилось, DOM не пересобираем —
// раньше каждый заход в чат и каждое событие (статус, набор текста, соединение) перерисовывали ленту 2–3 раза, и это было видно глазом.
// Окно отрисовки ленты: в DOM только последние N сообщений (до 5000 в чате — иначе вкладка тяжелеет), выше — кнопка «Показать более ранние».
const RENDER_WINDOW_STEP = 150;
const renderWindow = new Map(); // contactId -> сколько последних сообщений сейчас в DOM
let __suppressFreshAnim = false; // при подгрузке старых сообщений не проигрываем анимацию «появления» на каждом
function renderWindowOf(c) { return Math.max(renderWindow.get(c.id) || RENDER_WINDOW_STEP, RENDER_WINDOW_STEP); }
// Гарантирует, что сообщение есть в DOM (для переходов: ответ-цитата, закреп, поиск, избранное, переход к дате)
function ensureMessageRendered(contactId, msgId) {
  const c = state.contacts.get(contactId); if (!c) return false;
  const idx = c.messages.findIndex((m) => m.id === msgId); if (idx < 0) return false;
  const need = c.messages.length - idx + 20;
  if (need > renderWindowOf(c)) { renderWindow.set(c.id, need); __suppressFreshAnim = true; if (state.chatId === contactId) renderChatThreadInner(); }
  return true;
}
function chatRenderSig(c, q, list) {
  let h = c.id + "|" + q + "|" + (state.multiSelect ? Array.from(state.multiSelect).join(",") : "") + "|" + (unreadDividerFor.get(c.id) || "")
    + "|" + document.documentElement.lang + "|" + Store.linkPreviewMode + linkPreviewAllowed.size + "|" + linkPreviewCache.size + "|" + (c.pinnedMessageId || "") + "|" + (isGroup(c) ? "g" : "p") + "|" + (function () { try { return localStorage.getItem("ether.fx") || ""; } catch (e) { return ""; } })();
  h += "|win:" + (list ? list.length : c.messages.length);
  for (const m of (list || c.messages)) {
    h += "\n" + m.id + ":" + (m.rv || 0) + (m.ack || "") + (m.edited ? "e" : "") + (m.deleted ? "d" : "") + (m.favorite ? "f" : "") + (m.ttl || "") + (m.forwarded ? "w" : "") + ":" + (m.text || "")
      + (m.translation ? m.translation.text : "") + (m.reactions ? JSON.stringify(m.reactions) : "") + (m.poll && typeof EtherRich !== "undefined" && EtherRich.isClosed(m) ? "pc" : "")
      + (m.file ? [m.file.pending ? 1 : 0, m.file.failed ? 1 : 0, m.file.progress || "", m.file.w || ""].join("") : "") + (m.replyTo ? "r" : "");
  }
  return h;
}
function renderChatThreadInner() {
  const c = state.contacts.get(state.chatId);
  if (!c) { state.chatId = null; renderTab(); return; }
  const screenEl = $("#screen-chat"); if (screenEl) screenEl.setAttribute("aria-label", c.name || T("sys.someone"));
  const freshEntry = state.chatId !== __lastRenderedChatId;
  if (state.chatId !== __lastRenderedChatId) {
    // Тот же баг, что и в closeChatSafely — переключение МЕЖДУ чатами
    // не останавливало играющее голосовое из предыдущего чата.
    pauseAllVoicePlayback();
    closeQuickReactionFlyout(); // иначе плывущая панель реакций осталась бы висеть над уже другим чатом под ней
    try { if (state.threadRoot && state.threadRoot.cid !== state.chatId) closeThreadSheet(); } catch (e) {} // панель треда принадлежит прежнему чату

    // Свежий вход в чат — сбрасываем набор отрендеренных ранее id,
    // иначе новые сообщения в этом чате будут сравниваться с id из
    // ПРЕДЫДУЩЕГО чата и все получат "just-sent".
    __prevRenderedMsgIds = new Set();
    renderScheduleBanner();
    // Свежий вход в чат (а не повторный рендер того же самого) — если
    // есть непрочитанные, запоминаем id первого из них один раз здесь.
    // Дальше, пока пользователь не долистает вниз, ни бейдж, ни
    // разделитель не трогаем — специально НЕ зовём markThreadRead тут.
    if (!unreadDividerFor.has(c.id)) {
      const firstUnread = c.messages.find((m) => m.from === "them" && !m.readAckSent);
      if (firstUnread) unreadDividerFor.set(c.id, firstUnread.id);
    }
    __lastRenderedChatId = state.chatId;
  }
  if (c.messages.some((m) => isMsgExpired(m))) {
    const expired = c.messages.filter((m) => isMsgExpired(m));
    cleanupExpiredFileBlobs(expired);
    c.messages = c.messages.filter((m) => !isMsgExpired(m));
    persistContacts();
  }
  if (isGroup(c)) {
    ensureGroupConnections(c);
  } else if (c.managed && !isReachable(c)) {
    attemptConnectViaRelay(c.id).catch(() => {}); // на всякий случай — вдруг найдётся общий контакт, даже если сервер цель не видит
  }
  const nm = $("#chat-peer-name"); if (nm) nm.textContent = c.name || T("sys.someone");
  const avEl = $("#chat-peer-avatar"); if (avEl) avEl.innerHTML = avatarCircleHtml(c, null, "");
  const statusEl = $("#chat-peer-status");
  const typing = !isGroup(c) && state.typingTimers.has(c.id);
  if (statusEl) {
    if (isGroup(c)) { statusEl.textContent = T("group.memberCount", { n: c.members.length }); statusEl.classList.remove("typing"); }
    else if (typing) {
      // Оба печатают одновременно — отдельная подпись (общее «присутствие» в разговоре)
      const both = !!state.typingSendingState.get(c.id);
      statusEl.innerHTML = `<span class="typing-dots" aria-label="${escapeHtml(T(both ? "chat.typingBoth" : "chat.typing"))}"><span></span><span></span><span></span></span>` + (both ? `<span class="typing-both">${escapeHtml(T("chat.typingBoth"))}</span>` : "");
      statusEl.classList.add("typing"); statusEl.classList.toggle("typing-both-on", both);
    } else {
      statusEl.textContent = contactStatusLabel(c);
      statusEl.classList.remove("typing");
    }
  }
  const retryAllBtn = $("#chat-retry-all-btn");
  if (retryAllBtn) retryAllBtn.classList.toggle("hidden", !c.messages.some((m) => m.from === "me" && m.ack === "failed"));
  updateMultiSelectBanner();
  const pinnedBanner = $("#pinned-msg-banner");
  if (pinnedBanner) {
    const pinnedMsg = c.pinnedMessageId ? c.messages.find((m) => m.id === c.pinnedMessageId) : null;
    pinnedBanner.classList.toggle("hidden", !pinnedMsg);
    if (pinnedMsg) {
      const textEl = $("#pinned-msg-text");
      if (textEl) textEl.textContent = pinnedMsg.file ? T("chat.file.preview." + pinnedMsg.file.kind) : truncate(pinnedMsg.text || "", 60);
    } else if (c.pinnedMessageId) {
      // Сообщение удалено — чистим висячую ссылку. Раньше это не
      // сохранялось через persistContacts(): после перезагрузки страницы
      // c.pinnedMessageId читался из storage снова ненулевым и каждый
      // renderChatThreadInner заново его обнулял — чисто косметическая
      // гонка, но лишняя работа и теоретически мигающий баннер на долю
      // кадра до следующего рендера. Персистим один раз, когда реально
      // меняем значение (не на каждый рендер, когда оно уже null).
      c.pinnedMessageId = null;
      persistContacts();
    }
  }
  // Звонить можно и контакту не в сети: ему уйдёт push с приглашением (нужен только идентификатор, т.е. managed).
  const canCall = !isGroup(c) && !c.isSelf && (isReachable(c) || !!c.managed);
  const ccb = $("#chat-call-btn");
  if (ccb) { ccb.disabled = isGroup(c) ? false : !canCall; ccb.classList.remove("call-unavailable"); }
  const vcb = $("#chat-video-call-btn");
  if (vcb) { vcb.disabled = isGroup(c) ? false : !canCall; vcb.classList.remove("call-unavailable"); }
  // Файлы в группах не поддерживаются — раньше это выяснялось только
  // ПОСЛЕ выбора файла, когда sendFileMessage сам отказывал. Честнее не
  // показывать кнопку как рабочую вовсе. Кнопка микрофона решается в
  // updateSendVsMic() (там же учитывается видимость от текста в поле —
  // два независимых переключателя одного и того же .hidden конфликтовали бы).
  // Композер одинаковый в личных чатах и группах: вложения, камера и голосовые работают и там (в группе — до 1 МБ на файл)
  const attachBtn = $("#chat-attach-btn"); if (attachBtn) attachBtn.classList.remove("hidden");
  const cameraBtn = $("#chat-camera-btn"); if (cameraBtn) cameraBtn.classList.remove("hidden");
  // Раздел 8 — "права группы": не-админ видит явно закрытый композер
  // (с подсказкой), а не узнаёт о запрете только по тосту после попытки
  // отправить — так понятнее сразу, не трогая поле вообще.
  const writeBlocked = isGroup(c) && !isGroupWriteAllowed(c, Store.myId);
  const chatInputEl = $("#chat-input");
  if (chatInputEl) {
    chatInputEl.disabled = writeBlocked;
    chatInputEl.placeholder = writeBlocked ? T("chat.composerRestricted") : "";
  }

  const badge = $("#chat-transport-badge");
  const link = (mesh && !isGroup(c)) ? mesh.get(c.id) : null;
  { // Доверие к собеседнику: ключ проверен вами / канал подтверждён его ключом / ключ сменился
    const tb = $("#chat-trust-badge");
    if (tb) {
      let kind = "", label = "";
      if (isGroup(c) || c.isSelf) kind = "";
      else if (c.pendingKey) { kind = "warn"; label = T("trust.changed"); }
      else if (isContactVerified(c)) { kind = "verified"; label = T("trust.verified"); }
      else if (link && link.authState === "ok") { kind = "channel"; label = T("trust.channel"); }
      tb.className = "trust-badge" + (kind ? " is-" + kind : " hidden");
      tb.innerHTML = kind ? Icons.html(kind === "warn" ? "warning" : "shield", 14) : "";
      tb.setAttribute("aria-label", label); tb.title = label;
    }
  }
  if (badge) {
    // Три SVG-иконки вместо текстовых P2P / S / …: пользователю
    // непонятны эти аббревиатуры, а две встречные стрелки / облако /
    // пунктирный круг читаются интуитивно. Пояснение — в aria-label
    // (озвучивается скринридером, видно при долгом нажатии).
    if (isGroup(c)) {
      badge.classList.add("hidden");
      badge.innerHTML = "";
    } else if (link && (link.status === "connected" || link.status === "in-call")) {
      badge.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M2 8h12 M9.5 3.5 14 8l-4.5 4.5 M6.5 3.5 2 8l4.5 4.5"/></svg>`;
      badge.setAttribute("aria-label", T("chat.transport.direct"));
      badge.classList.remove("hidden", "via-server");
    } else if (link && link.status === "connecting") {
      badge.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-dasharray="3.5 3.5" stroke-linecap="round"/></svg>`;
      badge.setAttribute("aria-label", T("chat.transport.connecting"));
      badge.classList.add("via-server"); badge.classList.remove("hidden");
    } else if (c.managed && c.online) {
      badge.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" d="M4.7 11.5a3.2 3.2 0 0 1 0-6.4 4.7 4.7 0 0 1 8.9 1.4 2.6 2.6 0 0 1-.5 5z"/><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" d="M5.7 8.3h4.6"/></svg>`;
      badge.setAttribute("aria-label", T("chat.transport.server"));
      badge.classList.add("via-server"); badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
      badge.innerHTML = "";
      badge.removeAttribute("aria-label");
    }
  }

  const wrap = $("#chat-messages");
  if (!wrap) return;
  const wasAtBottom = isNearBottom(wrap);
  const savedScrollTop = wrap.scrollTop; // для случая "читал старое, не внизу, разделителя нет" — см. ниже
  // Якорь на первом видимом сообщении — savedScrollTop сам по себе
  // корректен, только если контент ВЫШЕ текущей позиции не меняется по
  // высоте между рендерами. Это верно для новых входящих (они всегда
  // добавляются в конец), но НЕ верно, если сообщения сверху исчезли
  // (TTL-очистка просроченных, обрезка истории) — тогда тот же
  // scrollTop указывал бы на другой контент, пользователя дёрнуло бы.
  let anchorMsgId = null, anchorTopBefore = 0;
  if (!wasAtBottom) {
    const wrapRect = wrap.getBoundingClientRect();
    for (const el of wrap.querySelectorAll("[data-msg-id]")) {
      const r = el.getBoundingClientRect();
      if (r.bottom > wrapRect.top) { anchorMsgId = el.getAttribute("data-msg-id"); anchorTopBefore = r.top; break; }
    }
  }
  const q = state.chatSearchQuery.toLowerCase();
  // Какие сообщения реально рисуем: при поиске — все (подсветка совпадений), иначе только последние renderWindowOf(c)
  let renderList = c.messages, hiddenBefore = 0;
  if (!q) {
    let win = renderWindowOf(c);
    const ua = unreadDividerFor.get(c.id);
    if (ua) { const ui = c.messages.findIndex((m) => m.id === ua); if (ui >= 0) win = Math.max(win, c.messages.length - ui + 10); } // разделитель «Непрочитанные» всегда в DOM
    if (c.messages.length > win) { hiddenBefore = c.messages.length - win; renderList = c.messages.slice(hiddenBefore); }
  }
  const sig = chatRenderSig(c, q, renderList);
  if (sig === __lastChatSig && wrap.dataset.renderedChat === c.id && wrap.childElementCount > 0) {
    // Ничего видимого не изменилось — DOM оставляем, только приводим в порядок прокрутку/поле ввода
    const dv = wrap.querySelector(".unread-divider");
    if (dv && freshEntry && !dividerScrolledFor.has(c.id)) { dv.scrollIntoView({ block: "center" }); dividerScrolledFor.add(c.id); }
    else if (freshEntry) wrap.scrollTop = wrap.scrollHeight;
    const inp = $("#chat-input");
    if (inp && !state.editingMessageId && state._inputDraftChatId !== c.id) { inp.value = state.drafts[c.id] || ""; state._inputDraftChatId = c.id; }
    updateScrollBottomButton(); updateSendVsMic();
    __prevRenderedMsgIds = new Set(renderList.map((m) => m.id)); // DOM уже показывает эти пузыри — следующее сообщение анимируем только само
    if (isNearBottom(wrap) && document.visibilityState !== "hidden") { unreadDividerFor.delete(c.id); dividerScrolledFor.delete(c.id); markThreadRead(c); }
    return;
  }
  __lastChatSig = sig; wrap.dataset.renderedChat = c.id;
  wrap.innerHTML = "";
  const frag = document.createDocumentFragment();
  let lastDay = "";
  const urlsToFetch = new Set();
  // Сколько ответов у каждого сообщения — для плашки «N ответов» (вход в тред)
  const replyCounts = new Map();
  for (const mm of c.messages) { const rid = mm.replyTo && (mm.replyTo.id || mm.replyTo.msgId); if (rid) replyCounts.set(rid, (replyCounts.get(rid) || 0) + 1); }
  let prevMsg = null;
  const unreadAnchorId = unreadDividerFor.get(c.id);
  let unreadDividerEl = null;
  // Набор id сообщений текущего рендера + признаки "только что
  // появившееся" для запуска анимации send/receive. Если при предыдущем
  // рендере в этом же чате уже были какие-то сообщения (prev.size > 0),
  // то всё, чего там не было, — новое. На самом первом рендере чата
  // prev пуст → ничего не считаем новым, иначе при открытии чата все
  // пузыри разом анимировались бы.
  const prevMsgIds = __prevRenderedMsgIds;
  const freshEnabled = (prevMsgIds.size > 0 || !freshEntry) && !__suppressFreshAnim;
  __suppressFreshAnim = false;
  const nextMsgIds = new Set();
  if (hiddenBefore > 0) {
    const more = document.createElement("button");
    more.type = "button"; more.className = "load-earlier-btn";
    more.textContent = T("chat.loadEarlier", { n: Math.min(hiddenBefore, RENDER_WINDOW_STEP) });
    more.addEventListener("click", () => { renderWindow.set(c.id, renderWindowOf(c) + RENDER_WINDOW_STEP); __suppressFreshAnim = true; renderChatThreadInner(); });
    frag.appendChild(more);
    // Листаете вверх — старые сообщения подгружаются сами, когда кнопка почти на экране
    if (typeof IntersectionObserver !== "undefined") setTimeout(() => {
      if (!more.isConnected) return;
      const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); more.click(); } }, { root: wrap, rootMargin: "160px 0px 0px 0px" });
      io.observe(more);
    }, 400);
  }
  for (const m of renderList) {
    nextMsgIds.add(m.id);
    const freshnessClass = (freshEnabled && !prevMsgIds.has(m.id))
      ? (m.from === "me" ? " just-sent" : " just-received")
      : "";
    if (unreadAnchorId && m.id === unreadAnchorId) {
      const div = document.createElement("div");
      div.className = "unread-divider";
      const span = document.createElement("span");
      span.textContent = T("chat.unreadDivider");
      div.appendChild(span);
      const unreadTexts = renderList.slice(renderList.indexOf(m)).filter((x) => x.from !== "me" && x.from !== "system" && x.text).map((x) => x.text);
      if (typeof LocalAI !== "undefined" && unreadTexts.join(" ").length >= 400) {
        const sb = document.createElement("button");
        sb.type = "button"; sb.className = "unread-summary-btn"; sb.textContent = T("ai.summary");
        sb.addEventListener("click", (e) => { e.stopPropagation(); openSummarySheet(unreadTexts.join(". ")); });
        div.appendChild(sb);
      }
      frag.appendChild(div);
      unreadDividerEl = div;
      prevMsg = null; // разделитель тоже разрывает визуальную группировку подряд идущих сообщений
    }
    if (m.from === "system") {
      const sys = document.createElement("div");
      sys.className = "system-message";
      const label = document.createElement("span");
      // Новые системные сообщения хранят ключ+параметры перевода и
      // переводятся здесь, при показе — на текущем языке, а не на том,
      // что был активен в момент создания сообщения. m.text остаётся как
      // запасной вариант для уже сохранённых старых записей (обратная
      // совместимость) и на случай, если ключ вдруг не найдётся.
      label.textContent = renderSystemMessageText(m);
      const time = document.createElement("span");
      time.className = "system-message-time";
      time.textContent = formatTime(m.ts);
      sys.appendChild(label);
      sys.appendChild(time);
      frag.appendChild(sys);
      prevMsg = null; // системное сообщение всегда разрывает визуальную группу
      continue;
    }
    const dayStr = formatDayGroup(m.ts);
    if (dayStr && dayStr !== lastDay) {
      const sep = document.createElement("div");
      sep.className = "date-sep date-sep-clickable";
      const inner = document.createElement("span");
      inner.textContent = dayStr;
      sep.appendChild(inner);
      // P2 — тап по разделителю даты открывает пикер даты, чтобы
      // прыгнуть в произвольный день переписки (а не просто подпись).
      sep.addEventListener("click", () => openJumpToDateSheet(state.chatId));
      frag.appendChild(sep);
      lastDay = dayStr;
      prevMsg = null; // новый день — тоже новая группа
    }
    // Подряд идущие сообщения одного собеседника (в пределах 5 минут) визуально
    // сближаем — так делают WhatsApp/Telegram/iMessage: понятно, что это одна
    // "реплика", а не череда отдельных сообщений.
    const grouped = !!(prevMsg && prevMsg.from === m.from && (m.from !== "them" || !isGroup(c) || prevMsg.fromId === m.fromId) && m.ts - prevMsg.ts < 5 * 60 * 1000);
    const bubble = document.createElement("div");
    const msIsOn = !!state.multiSelect;
    const msSelected = msIsOn && state.multiSelect.has(m.id);
    bubble.className = "bubble-row " + (m.from === "me" ? "mine" : "theirs") + (grouped ? " grouped" : "") + freshnessClass + (msIsOn ? " multiselect-active" : "") + (msSelected ? " multiselect-selected" : "");
    if (msIsOn) {
      const check = document.createElement("div");
      check.className = "multiselect-checkbox" + (msSelected ? " checked" : "");
      bubble.appendChild(check);
    }
    let tick = m.from === "me" ? ackGlyph(m.ack) : "";
    // Смена статуса доставки у уже нарисованного сообщения — галочка «прыгает» (на первой отрисовке и при заходе в чат — нет)
    if (m.from === "me" && m.ack) {
      const prevAck = __renderedAck.get(m.id);
      if (prevAck !== undefined && prevAck !== m.ack) tick = tick.replace('class="ack-tick', 'class="ack-tick ack-pop');
      __renderedAck.set(m.id, m.ack); if (__renderedAck.size > 4000) trimMap(__renderedAck, 3000);
    }
    const editedMark = m.edited ? `<span class="bubble-edited">${escapeHtml(T("chat.edit"))}</span>` : "";
    const ttlMark = m.ttl ? `<span class="bubble-ttl" title="${escapeHtml(disappearingTimerLabel(m.ttl))}">${Icons.html("hourglass", 12)}</span>` : "";
    const favMark = m.favorite ? `<span class="bubble-favorite" title="${escapeHtml(T("chat.favorite"))}">${Icons.html("star", 11)}</span>` : "";
    const inner = document.createElement("div");
    // Класс glass-content убран с чужих пузырей: новый дизайн — матовый
    // фон --bg-2 + тонкий border (см. styles.css). Стекло на десятках
    // пузырей одновременно и перегружало визуально, и нагружало
    // композитинг (20+ blur-слоёв).
    inner.className = "bubble" + (m.mentionMe ? " bubble-mentioned" : "") + (m.sticker ? " bubble-sticker" : "");
    inner.setAttribute("data-msg-id", m.id); // для прокрутки к оригиналу по тапу на цитате ответа
    const body = m.sticker && window.EtherStickers && EtherStickers.bubbleHtml ? EtherStickers.bubbleHtml(m) : m.file ? fileBubbleHtml(m.id, m.file) : m.poll ? pollBubbleHtml(c, m) : m.board ? boardBubbleHtml(m) : m.note ? noteBubbleHtml(m) : (m.contactCard ? contactCardBubbleHtml(m.contactCard) : linkifyAndHighlight(m.text, q));
    const isFirstOfGroupBlock = !prevMsg || prevMsg.fromId !== m.fromId || prevMsg.from !== "them";
    const senderLabel = (isGroup(c) && m.from === "them" && m.fromId && isFirstOfGroupBlock)
      ? `<div class="bubble-sender">${escapeHtml(m.fromName || T("sys.someone"))}</div>` : "";
    let previewSlotHtml = "";
    let previewUrl = null;
    if (Store.linkPreviewMode !== "off" && !m.deleted) {
      previewUrl = extractFirstUrl(m.text);
      if (previewUrl) {
        const cached = linkPreviewCache.get(previewUrl);
        if (cached && cached.status === "done" && cached.data) {
          previewSlotHtml = linkPreviewCardHtml(cached.data);
        } else if (Store.linkPreviewMode === "ask" && !linkPreviewAllowed.has(previewUrl)) {
          previewSlotHtml = `<button type="button" class="link-preview-ask" data-preview-ask="${escapeHtml(previewUrl)}">${Icons.html("link", 14)}<span>${escapeHtml(T("linkPreview.ask"))}</span></button>`;
        } else if (!cached || cached.status !== "none") {
          previewSlotHtml = `<div class="link-preview-slot" data-preview-for="${escapeHtml(previewUrl)}"></div>`;
          urlsToFetch.add(previewUrl);
        }
      }
    }
    let replyHtml = "";
if (m.replyTo) {
  // Поле переименовано у отправителя: rec.replyTo.id (не msgId). Читаем
  // оба варианта — для старых сообщений, сохранённых ещё с msgId.
  const rtId = m.replyTo.id || m.replyTo.msgId || "";
  replyHtml = `<div class="bubble-reply" data-reply-to-id="${escapeHtml(rtId)}"><div class="bubble-reply-author">${escapeHtml(m.replyTo.authorName || "")}</div><div class="bubble-reply-text">${escapeHtml(truncate(m.replyTo.text || "", 80))}</div></div>`;
}
    const fwdMark = m.forwarded ? `<div class="bubble-forwarded">${escapeHtml(m.forwardedFrom ? T("chat.forwardedFrom", { name: m.forwardedFrom }) : T("chat.forwarded"))}</div>` : "";
    let reactionsHtml = "";
    if (m.reactions && typeof m.reactions === "object") {
      const chips = Object.entries(m.reactions).filter(([, users]) => Array.isArray(users) && users.length > 0);
      if (chips.length > 0) reactionsHtml = `<div class="bubble-reactions">` + chips.map(([emoji, users]) => `<span class="bubble-reaction-chip" data-emoji="${escapeHtml(emoji)}">${escapeHtml(emoji)} ${typeof fxReactionStack === "function" ? fxReactionStack(users) : ""}${users.length}</span>`).join("") + `</div>`;
    }
    // Перевод (раздел 5 роадмапа) — показывается ПОД оригинальным текстом,
    // не заменяет его: честно видно и то, что собеседник написал сам, и
    // то, во что это превратил сторонний сервер перевода.
    const translationHtml = (m.translation && m.translation.text)
      ? `<div class="bubble-translation"><span class="bubble-translation-label">${escapeHtml(T("chat.translated"))}</span> ${linkifyAndHighlight(m.translation.text, q)}</div>` : "";
    if (typeof m.text === "string" && (m.text.length > 140 || (m.text.match(/\n/g) || []).length >= 3)) inner.classList.add("bubble-long");
    const threadChip = replyCounts.get(m.id) ? `<button type="button" class="thread-chip" data-thread="${escapeHtml(m.id)}" aria-haspopup="dialog" aria-label="${escapeHtml(T("chat.thread.aria", { n: replyCounts.get(m.id) }))}">${Icons.html("chat", 13)}<span>${escapeHtml(T("chat.thread.replies", { n: replyCounts.get(m.id) }))}</span></button>` : "";
    inner.innerHTML = `${senderLabel}${fwdMark}${replyHtml}${body}${threadChip}${translationHtml}${previewSlotHtml}<span class="bubble-time">${ttlMark}${favMark}${formatTime(m.ts)}${editedMark}${tick}</span>${reactionsHtml}`;
    // Долгое нажатие — открывает обычное меню действий (ответить/
    // переслать/удалить), для ЛЮБОГО типа сообщения, как в большинстве
    // мессенджеров. Обычный тап при этом делает контентно-зависимое
    // действие по умолчанию (см. ниже) вместо меню.
    let longPressFired = false;
    let longPressTimer = null;
    let longPressLiftTimer = null;
    let longPressMoved = false;
    let lpStartX = 0, lpStartY = 0;
    function startLongPress(x, y) {
      longPressMoved = false;
      lpStartX = x; lpStartY = y;
      clearTimeout(longPressTimer);
      clearTimeout(longPressLiftTimer);
      // Раньше пузырь неподвижно стоял все 500мс до открытия меню — на
      // ощупь это "залипание", а не нажатие. "Приподнимаем" его уже
      // через 100мс как лёгкий отклик на палец, до того как решится,
      // долгое это нажатие или нет.
      longPressLiftTimer = setTimeout(() => { if (!longPressMoved) inner.classList.add("bubble-pressing"); }, 100);
      longPressTimer = setTimeout(() => {
        if (!longPressMoved && !state.multiSelect) {
          longPressFired = true;
          try { if (navigator.vibrate) navigator.vibrate(15); } catch (e) {}
          // Группы не поддерживают реакции (см. комментарий в
          // openMessageSheet) — там долгое нажатие ведёт прямо в старую
          // полную шторку действий, без промежуточной плывущей панели,
          // которой для этого чата всё равно было бы нечего показывать.
          openQuickReactionFlyout(inner, m.id, c.id);
        }
        inner.classList.remove("bubble-pressing");
      }, 500);
    }
    function moveLongPress(x, y) {
      if (Math.abs(x - lpStartX) > 10 || Math.abs(y - lpStartY) > 10) {
        longPressMoved = true; clearTimeout(longPressTimer); clearTimeout(longPressLiftTimer);
        inner.classList.remove("bubble-pressing");
      }
    }
    function endLongPress() { clearTimeout(longPressTimer); clearTimeout(longPressLiftTimer); inner.classList.remove("bubble-pressing"); }
    inner.addEventListener("touchstart", (e) => { const t = e.touches[0]; startLongPress(t.clientX, t.clientY); }, { passive: true });
    inner.addEventListener("touchmove", (e) => { const t = e.touches[0]; moveLongPress(t.clientX, t.clientY); }, { passive: true });
    inner.addEventListener("touchend", endLongPress);
    inner.addEventListener("touchcancel", endLongPress);
    inner.addEventListener("mousedown", (e) => startLongPress(e.clientX, e.clientY));
    inner.addEventListener("mousemove", (e) => { if (longPressTimer) moveLongPress(e.clientX, e.clientY); });
    inner.addEventListener("mouseup", endLongPress);
    inner.addEventListener("mouseleave", endLongPress);

    inner.addEventListener("click", (ev) => {
      if (longPressFired) { longPressFired = false; return; } // меню уже открыто долгим нажатием — не открываем ещё и обычное действие следом
      if (state.multiSelect) { ev.stopPropagation(); toggleMultiSelectMsg(m.id); return; }
      const askEl = ev.target.closest("[data-preview-ask]");
      if (askEl) { ev.stopPropagation(); linkPreviewAllowed.add(askEl.getAttribute("data-preview-ask")); renderChatThread(); return; }
      const threadEl = ev.target.closest("[data-thread]");
      if (threadEl) { ev.stopPropagation(); openThread(c.id, threadEl.getAttribute("data-thread")); return; }
      const richEl = ev.target.closest("[data-poll-opt], [data-poll-close], [data-board-act], [data-note-edit]");
      if (richEl) { ev.stopPropagation(); handleRichClick(c, m, richEl); return; }
      const addBtn = ev.target.closest(".contact-card-add-btn");
      if (addBtn) {
        ev.stopPropagation();
        const cardId = addBtn.getAttribute("data-add-contact-id");
        const cardName = addBtn.getAttribute("data-add-contact-name") || "";
        if (cardId) addContactFromCard(cardId, cardName);
        return;
      }
      // Тап по цитате ответа — прокрутка к оригинальному сообщению, а
      // не общее меню поверх него. Проверяем раньше остальных веток,
      // т.к. цитата может быть частью пузыря любого типа (текст, файл).
      // Тап по "!" (недоставленное) сразу открывает меню сообщения —
      // раньше "Повторить" было спрятано в шите, куда добирается
      // меньшинство пользователей; статус-иконка была мёртвым маркером.
      const retryEl = ev.target.closest(".ack-failed[data-retry]");
      if (retryEl) { ev.stopPropagation(); retryMessage(c.id, m.id); toast(T("toast.retrying")); return; }
      const replyQuoteEl = ev.target.closest(".bubble-reply[data-reply-to-id]");
      if (replyQuoteEl) {
        ev.stopPropagation();
        const targetId = replyQuoteEl.getAttribute("data-reply-to-id");
        if (targetId && !wrap.querySelector(`[data-msg-id="${CSS.escape(targetId)}"]`)) ensureMessageRendered(c.id, targetId);
        const targetEl = targetId && document.querySelector(`#chat-messages [data-msg-id="${CSS.escape(targetId)}"]`);
        if (targetEl) {
          targetEl.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
          targetEl.classList.add("highlight-origin");
          setTimeout(() => targetEl.classList.remove("highlight-origin"), 1500);
        } else {
          toast(T("chat.replyOriginalGone"));
        }
        return;
      }
      // Ссылка (обычный текст со ссылкой или карточка превью) — своё
      // меню выбора действия, а не переход напрямую и не общее меню
      // сообщения одновременно (раньше срабатывало и то, и другое).
      const docLink = ev.target.closest("a.file-bubble-doc[data-file-id]");
      if (docLink) {
        // отдаём браузеру скачать blob — не перехватываем
        return;
      }
      const linkEl = ev.target.closest("a[href]");
      if (linkEl) {
        ev.preventDefault();
        ev.stopPropagation();
        openLinkActionSheet(linkEl.href);
        return;
      }
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      if (ev.target.closest(".voice-play-btn, .voice-wave, .voice-speed-btn, .voice-tr-btn, .voice-transcript")) return; // у кнопки уже есть свой обработчик — тут просто не открываем меню поверх него
      if (m.file && m.file.kind === "audio" && !m.file.pending) {
        toggleVoicePlaybackFor(inner);
        return;
      }
      if (m.file && (m.file.kind === "image" || m.file.kind === "video") && !m.file.pending) {
        getFileBlobUrl(m.id).then((url) => { if (url) openMediaViewer(url, m.file.kind); });
        return;
      }
      // Двойной тап по обычному тексту пузыря — быстрая реакция (❤️ или
      // последняя использованная), без открытия меню сообщения. Открытие
      // меню по одиночному тапу откладывается на короткое окно (220мс),
      // достаточное, чтобы отличить один тап от двух, но не заметное на
      // глаз как задержка.
      if (!isGroup(c)) {
        const prev = __bubbleTapState.get(m.id);
        if (prev && Date.now() - prev.time < 320) {
          clearTimeout(prev.timer);
          __bubbleTapState.delete(m.id);
          const quickEmoji = (Store.recentReactions[0]) || "❤️";
          toggleReaction(c.id, m.id, quickEmoji);
          spawnReactionBurst(inner, quickEmoji);
          return;
        }
        const timer = setTimeout(() => { __bubbleTapState.delete(m.id); if (state.chatId === c.id) openMessageSheet(m.id, c.id); }, 220);
        __bubbleTapState.set(m.id, { time: Date.now(), timer });
        return;
      }
      openMessageSheet(m.id, c.id);
    });
    attachSwipeReply(inner, m, c);
    if (isGroup(c) && m.from === "them") {
      // Аватар собеседника в групповом чате — иначе посреди блока
      // одинаковых по стилю "чужих" пузырей непонятно, кто именно
      // написал, не читая имя в самом верху блока.
      const avatarSlot = document.createElement("div");
      avatarSlot.className = "bubble-row-avatar" + (isFirstOfGroupBlock ? " avatar-visible" : "");
      if (isFirstOfGroupBlock) {
        const senderContact = state.contacts.get(m.fromId) || { name: m.fromName };
        avatarSlot.innerHTML = avatarCircleHtml(senderContact, null, "");
      }
      bubble.appendChild(avatarSlot);
    }
    bubble.appendChild(inner);
    frag.appendChild(bubble);
    prevMsg = m;
  }
  wrap.appendChild(frag);
  // Пустой чат (ни одного сообщения) — вместо голой пустоты объясняем,
  // что это E2E-переписка, и даём быстрый старт одним тапом.
  if (c.messages.length === 0 && !isGroup(c)) {
    const es = document.createElement("div");
    es.className = "chat-thread-empty";
    es.innerHTML = `
      <div class="chat-thread-empty-icon"><svg viewBox="0 0 24 24" width="40" height="40"><path fill="currentColor" d="M12 2a9 9 0 0 0-9 9c0 1.6.42 3.1 1.15 4.4L3 21l5.75-1.1A9 9 0 1 0 12 2zm-4 8a1.2 1.2 0 1 1 0 2.4A1.2 1.2 0 0 1 8 10zm4 0a1.2 1.2 0 1 1 0 2.4A1.2 1.2 0 0 1 12 10zm4 0a1.2 1.2 0 1 1 0 2.4A1.2 1.2 0 0 1 16 10z"/></svg></div>
      <p class="chat-thread-empty-title">${escapeHtml(T("chat.thread.empty.title"))}</p>
      <button type="button" class="btn-secondary chat-thread-empty-wave" id="chat-thread-empty-wave-btn">${escapeHtml(T("chat.thread.empty.wave"))}</button>`;
    wrap.appendChild(es);
    const waveBtn = es.querySelector("#chat-thread-empty-wave-btn");
    if (waveBtn) waveBtn.addEventListener("click", () => { sendChatMessage(c.id, T("chat.thread.empty.waveText")); });
  }
  // Сохраняем набор отрендеренных id — при следующем рендере только
  // сообщения, которых тут не было, получат анимацию появления.
  __prevRenderedMsgIds = nextMsgIds;
  // Лениво: не фетчим всё сразу (см. observeLinkPreviewSlot) — наблюдаем
  // только реально созданные в этом рендере слоты, а не вызываем
  // renderLinkPreviewInto(u) для каждого url из urlsToFetch напрямую.
  if (urlsToFetch.size > 0) {
    wrap.querySelectorAll('.link-preview-slot[data-preview-for]').forEach((slot) => {
      if (urlsToFetch.has(slot.getAttribute("data-preview-for"))) observeLinkPreviewSlot(slot);
    });
  }
  hydrateFileSlots(wrap);
  try { if (window.EtherStickers && EtherStickers.hydrate) EtherStickers.hydrate(wrap); } catch (e) {}
  // Hydrate асинхронно подгружает картинки/видео из IDB и заметно
  // увеличивает высоту контента. Если пользователь был у низа — дожимаем
  // скролл вниз после того, как всё подгрузилось, иначе layout shift
  // оставляет его «выше низа» на высоту новых картинок, а следующий
  // рендер (например, sweepExpiredMessages раз в 30с) улетает в середину
  // списка, потому что wasAtBottom уже false.
  if (wasAtBottom) {
    const keepBottom = () => { if (isNearBottom(wrap) || wasAtBottom) wrap.scrollTop = wrap.scrollHeight; };
    requestAnimationFrame(keepBottom);
    setTimeout(keepBottom, 300);
    setTimeout(keepBottom, 900);
  }
  if (unreadDividerEl && !dividerScrolledFor.has(c.id)) {
    // Свежий вход в чат с непрочитанными — показываем место, где они
    // начинаются, а не сразу прыгаем в самый низ (иначе пользователь
    // никогда бы не увидел разделитель). Только один раз — не на каждый
    // повторный рендер, пока пользователь ещё не долистал.
    unreadDividerEl.scrollIntoView({ block: "center" });
    dividerScrolledFor.add(c.id);
  } else if (!unreadDividerEl && wasAtBottom) {
    wrap.scrollTop = wrap.scrollHeight;
  } else if (!unreadDividerEl) {
    // Пользователь читал старую переписку (не у низа, разделителя нет —
    // либо уже снят, либо его и не было). wrap.innerHTML = "" выше
    // полностью пересобирает DOM на КАЖДЫЙ рендер. Если есть якорное
    // сообщение и оно всё ещё существует после пересборки — подгоняем
    // scrollTop так, чтобы оно осталось в той же позиции на экране
    // (компенсирует изменение высоты контента выше, если сверху что-то
    // исчезло — TTL, обрезка истории). Если якоря нет или само якорное
    // сообщение тоже пропало — откатываемся на старое поведение.
    const anchorEl = anchorMsgId ? wrap.querySelector(`[data-msg-id="${CSS.escape(anchorMsgId)}"]`) : null;
    if (anchorEl) {
      const anchorTopAfter = anchorEl.getBoundingClientRect().top;
      wrap.scrollTop += anchorTopAfter - anchorTopBefore;
    } else {
      wrap.scrollTop = savedScrollTop;
    }
  }
  updateScrollBottomButton();
  const input = $("#chat-input");
  if (input && !state.editingMessageId) {
    // Черновик привязан к чату: при смене чата поле ЗАМЕНЯЕТСЯ его черновиком или очищается.
    // Раньше, если у нового чата черновика не было, в поле оставался текст предыдущего чата.
    // Перерисовка того же чата (входящее сообщение) поле не трогает — иначе сбивался бы ввод.
    if (state._inputDraftChatId !== c.id) {
      // Поле всё ещё содержит текст ПРЕДЫДУЩЕГО чата (смена чата в обход closeChatSafely, например из
      // глобального поиска) — сохраняем его как черновик того чата, прежде чем заменить.
      const prevId = state._inputDraftChatId;
      if (prevId && state.contacts.has(prevId)) {
        const pv = input.value.trim();
        if (pv) state.drafts[prevId] = pv; else delete state.drafts[prevId];
        persistDrafts();
      }
      input.value = state.drafts[c.id] || "";
      state._inputDraftChatId = c.id;
    }
  }
  updateSendVsMic();
  // markThreadRead — только если сейчас реально видно низ переписки. Раньше
  // условие было "нет разделителя ИЛИ у низа" — но разделитель ставится
  // ТОЛЬКО при свежем входе в чат (state.chatId меняется), а не когда новое
  // сообщение приходит в уже открытый и полностью прочитанный чат. В этом
  // случае unreadDividerFor.has() всегда false, и старое условие срабатывало
  // независимо от прокрутки — новое сообщение помечалось прочитанным, даже
  // если пользователь в этот момент листал старую переписку выше. Оставляем
  // только реальную проверку прокрутки.
  if (isNearBottom(wrap) && document.visibilityState !== "hidden") {
    unreadDividerFor.delete(c.id);
    dividerScrolledFor.delete(c.id);
    markThreadRead(c);
  }

  if (state.chatSearchQuery) {
    if (__chatSearchScrollTimer) clearTimeout(__chatSearchScrollTimer);
    __chatSearchScrollTimer = setTimeout(() => {
      const marks = wrap.querySelectorAll(".search-hit");
      if (marks.length > 0) marks[0].scrollIntoView({ behavior: "smooth", block: "center" });
    }, 200);
  }
}
const __bubbleTapState = new Map(); // msgId -> { time, timer } — для различения одиночного/двойного тапа по пузырю
let __openChatRowWrapper = null; // только одна открытая свайпом строка одновременно — стандартный паттерн (iOS Mail, Gmail)
function closeOpenChatRow() {
  if (__openChatRowWrapper) {
    const r = __openChatRowWrapper.querySelector(".chat-row");
    if (r) r.style.transform = "";
    __openChatRowWrapper.classList.remove("swiped-start", "swiped-end");
    __openChatRowWrapper = null;
  }
}
const CHAT_ROW_REVEAL_PX = 168; // две кнопки слева (mute + архив), см. комментарий у END_PX
const CHAT_ROW_REVEAL_END_PX = 168; // две кнопки (pin + удалить, справа)
function attachChatRowSwipe(wrapper, row, c) {
  let startX = 0, startY = 0, dragging = false, currentX = 0;
  const isRtl = document.documentElement.dir === "rtl";
  // .chat-row-actions-start (архив) — inset-inline-start: физически
  // слева в LTR, физически СПРАВА в RTL (логические CSS-свойства сами
  // разворачиваются). Перетаскивание всегда 1:1 следует за пальцем без
  // единой инверсии — это единственный вариант, который не выглядит
  // сломанным ни в LTR, ни в RTL. RTL влияет ТОЛЬКО на то, какую панель
  // означает положительный/отрицательный сдвиг — это решается один раз,
  // в момент отпускания, а не размазано по вычислению координат.
  // Панели асимметричны (start — 1 кнопка, end — 2 кнопки: pin+delete),
  // поэтому дистанция "полного открытия" разная для каждой стороны.
  row.addEventListener("touchstart", (e) => {
    startX = e.touches[0].clientX; startY = e.touches[0].clientY;
    dragging = false;
    if (__openChatRowWrapper && __openChatRowWrapper !== wrapper) closeOpenChatRow();
    currentX = wrapper.classList.contains("swiped-start") ? CHAT_ROW_REVEAL_PX : wrapper.classList.contains("swiped-end") ? -CHAT_ROW_REVEAL_END_PX : 0;
    row.style.transition = "none";
  }, { passive: true });
  row.addEventListener("touchmove", (e) => {
    const rawDx = e.touches[0].clientX - startX + currentX;
    const dy = Math.abs(e.touches[0].clientY - startY);
    if (!dragging && Math.abs(rawDx - currentX) > 10 && Math.abs(rawDx - currentX) > dy) dragging = true;
    if (!dragging) return;
    const dx = Math.max(-CHAT_ROW_REVEAL_END_PX * 1.3, Math.min(CHAT_ROW_REVEAL_PX * 1.3, rawDx));
    row.style.transform = `translateX(${dx}px)`;
    // кнопки действий показываем только с той стороны, в которую тянут (иначе они просвечивают сквозь полупрозрачную плашку)
    wrapper.classList.toggle("drag-start", dx > 4); wrapper.classList.toggle("drag-end", dx < -4);
  }, { passive: true });
  row.addEventListener("touchend", () => {
    row.style.transition = "";
    if (!dragging) return;
    setTimeout(() => wrapper.classList.remove("drag-start", "drag-end"), 260);
    const m1 = row.style.transform.match(/translateX\((-?\d+(?:\.\d+)?)px\)/);
    const dx = m1 ? parseFloat(m1[1]) : 0;
    // Положительный сдвиг открывает панель, которая физически СЛЕВА —
    // это "start" в LTR, но "end" в RTL (см. комментарий выше).
    const wantsPhysicalLeftPanel = dx > CHAT_ROW_REVEAL_PX / 2;
    const wantsPhysicalRightPanel = dx < -CHAT_ROW_REVEAL_END_PX / 2;
    const opensStart = isRtl ? wantsPhysicalRightPanel : wantsPhysicalLeftPanel;
    const opensEnd = isRtl ? wantsPhysicalLeftPanel : wantsPhysicalRightPanel;
    if (opensStart) {
      row.style.transform = `translateX(${CHAT_ROW_REVEAL_PX}px)`;
      wrapper.classList.add("swiped-start"); wrapper.classList.remove("swiped-end");
      __openChatRowWrapper = wrapper;
      haptic("light");
    } else if (opensEnd) {
      row.style.transform = `translateX(${-CHAT_ROW_REVEAL_END_PX}px)`;
      wrapper.classList.add("swiped-end"); wrapper.classList.remove("swiped-start");
      __openChatRowWrapper = wrapper;
      haptic("light");
    } else {
      row.style.transform = "";
      wrapper.classList.remove("swiped-start", "swiped-end");
      if (__openChatRowWrapper === wrapper) __openChatRowWrapper = null;
    }
    dragging = false;
  });
  // Если строка открыта свайпом, тап по НЕЙ САМОЙ закрывает её вместо
  // перехода в чат — навигация возвращается только когда строка закрыта.
  row.addEventListener("click", (ev) => {
    if (wrapper.classList.contains("swiped-start") || wrapper.classList.contains("swiped-end")) {
      ev.stopImmediatePropagation();
      closeOpenChatRow();
    }
  }, true);
  wrapper.querySelector(".chat-row-action-archive").addEventListener("click", () => {
    closeOpenChatRow();
    c.archived = !c.archived; persistContacts(); haptic("light"); renderChatsList();
  });
  wrapper.querySelector(".chat-row-action-mute").addEventListener("click", () => {
    closeOpenChatRow();
    // Свайп-мьют из списка чатов — всегда постоянный (без шторки выбора
    // длительности, см. #mute-sheet в карточке контакта): это
    // быстрое действие на одну строку, а не отдельный флоу.
    if (isContactMuted(c)) { c.muted = false; c.muteUntil = null; }
    else { c.muted = true; }
    persistContacts(); haptic("light");
    toast(c.muted ? T("toast.muted") : T("toast.unmuted"));
    renderChatsList();
  });
  wrapper.querySelector(".chat-row-action-pin").addEventListener("click", () => {
    closeOpenChatRow();
    c.pinned = !c.pinned;
    if (c.pinned) c.pinOrder = nextPinOrder(); else c.pinOrder = null;
    persistContacts(); haptic("light"); renderChatsList();
  });
  wrapper.querySelector(".chat-row-action-delete").addEventListener("click", async () => {
    if (!await confirmSheet(T("toast.confirmDeleteContact", { name: c.name }), { destructive: true })) { closeOpenChatRow(); return; }
    closeOpenChatRow();
    deleteContact(c.id);
  });
}
// ===== Контекстное меню строки чата (долгое нажатие / правая кнопка) и меню «⋯» в шапке чата =====
function chatMuteItems(c, after) {
  const apply = (until, forever) => { if (forever) { c.muted = true; c.muteUntil = null; } else { c.muted = false; c.muteUntil = until; } persistContacts(); toast(forever ? T("toast.muted") : T("chat.mute.until", { time: formatChatListTime(until) })); if (after) after(); };
  const tmr = new Date(); tmr.setDate(tmr.getDate() + 1); tmr.setHours(9, 0, 0, 0);
  return [
    { label: T("chat.contact.mute.1h"), icon: "bell", fn: () => apply(Date.now() + 3600000, false) },
    { label: T("chat.contact.mute.8h"), icon: "bell", fn: () => apply(Date.now() + 8 * 3600000, false) },
    { label: T("chat.contact.mute.tomorrow"), icon: "bell", fn: () => apply(tmr.getTime(), false) },
    { label: T("chat.contact.mute.forever"), icon: "bell", fn: () => apply(null, true) },
  ];
}
function toggleChatMute(c, after) {
  if (isContactMuted(c)) { c.muted = false; c.muteUntil = null; persistContacts(); toast(T("toast.unmuted")); if (after) after(); }
  else openActionSheet(T("chat.contact.mute"), chatMuteItems(c, after));
}
function openChatFolderPicker(c) {
  if (!state.folders.length) { toast(T("chats.folder.none")); return; }
  openActionSheet(T("chats.action.folder"), state.folders.map((f) => {
    const inIt = f.contactIds.includes(c.id);
    return { label: (inIt ? "✓ " : "") + f.name, icon: "archive", fn: () => { f.contactIds = inIt ? f.contactIds.filter((x) => x !== c.id) : f.contactIds.concat(c.id); persistChatFolders(); renderChatsList(); } };
  }));
}
function openChatRowMenu(c) {
  const refresh = () => { try { renderChatsList(); } catch (e) {} };
  openActionSheet(c.name || T("sys.someone"), [
    { label: c.pinned ? T("chats.unpin") : T("chats.pin"), icon: "pin", fn: () => { c.pinned = !c.pinned; c.pinOrder = c.pinned ? nextPinOrder() : null; persistContacts(); refresh(); } },
    { label: isContactMuted(c) ? T("chats.action.unmute") : T("chats.action.mute"), icon: "bell", fn: () => toggleChatMute(c, refresh) },
    { label: T("chats.action.folder"), icon: "archive", fn: () => openChatFolderPicker(c) },
    { label: c.markedUnread ? T("chats.action.markRead") : T("chats.action.markUnread"), icon: "chat", fn: () => { c.markedUnread = !c.markedUnread; persistContacts(); refresh(); } },
    { label: c.archived ? T("chats.action.unarchive") : T("chats.action.archive"), icon: "archive", fn: () => { c.archived = !c.archived; persistContacts(); refresh(); } },
  ]);
}
function attachChatRowContext(row, c) {
  row.addEventListener("contextmenu", (e) => { e.preventDefault(); row.__longPressed = true; openChatRowMenu(c); });
  let t = null, x = 0, y = 0;
  const cancel = () => { clearTimeout(t); t = null; };
  row.addEventListener("pointerdown", (e) => { if (e.pointerType === "mouse") return; x = e.clientX; y = e.clientY; cancel(); t = setTimeout(() => { t = null; if (row.__longPressed) return; row.__longPressed = true; haptic("light"); openChatRowMenu(c); }, 600); });
  row.addEventListener("pointermove", (e) => { if (t && (Math.abs(e.clientX - x) > 8 || Math.abs(e.clientY - y) > 8)) cancel(); });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) row.addEventListener(ev, cancel);
}
function openChatHeaderMenu() {
  const id = state.chatId, c = id && state.contacts.get(id); if (!c) return;
  const items = [
    { label: T("chat.search"), icon: "search", fn: () => { const b = $("#chat-search-btn"); if (b) b.click(); } },
    { label: T("chat.contact.gallery"), icon: "image", fn: () => openContactCard(id) },
    { label: T("chat.pinned"), icon: "pin", fn: () => { if (!c.pinnedMessageId) { toast(T("chat.pinned.none")); return; } const j = $("#pinned-msg-jump"); if (j) j.click(); } },
    { label: isContactMuted(c) ? T("chats.action.unmute") : T("chat.contact.mute"), icon: "bell", fn: () => toggleChatMute(c, () => { try { renderChatThreadInner(); } catch (e) {} }) },
    { label: T("chat.disappearing"), icon: "clock", fn: () => openActionSheet(T("chat.disappearing"), [["chat.disappearing.off", 0], ["chat.disappearing.1h", 3600000], ["chat.disappearing.1d", 86400000], ["chat.disappearing.1w", 604800000]].map(([k, ms]) => ({ label: ((c.disappearingTimer || 0) === ms ? "✓ " : "") + T(k), icon: "clock", fn: () => setDisappearingTimer(id, ms) }))) },
    { label: T("summary.menu"), icon: "sparkle", fn: () => { if (typeof openChatSummary === "function") openChatSummary(id); } },
    { label: T("chat.contact.export"), icon: "download", fn: () => exportChat(id) },
    { label: T("chat.contact.clear"), icon: "trash", danger: true, fn: async () => {
      if (!await confirmSheet(T("toast.confirmDeleteChat", { name: c.name }), { destructive: true })) return;
      cleanupExpiredFileBlobs(c.messages); c.messages = []; c.lastActivity = Date.now(); persistContacts();
      try { renderChatThreadInner(); } catch (e) {} toast(T("toast.historyCleared"));
    } },
  ];
  openActionSheet(c.name || "", items);
}
function wireChatHeaderMenu() {
  const b = $("#chat-more-btn"); if (b) b.addEventListener("click", openChatHeaderMenu);
}
// ===== Командная палитра (Ctrl/⌘+K) =====
let __cmdkIdx = 0, __cmdkItems = [];
function cmdkBuildItems(q) {
  q = (q || "").trim().toLowerCase();
  const go = (tab) => () => { state.tab = tab; state.chatId = null; state.contactCardId = null; renderTab(); };
  const all = [];
  for (const c of state.contacts.values()) { if (c.isDemo && false) continue; all.push({ g: T("cmdk.chats"), label: c.name || T("sys.someone"), icon: "chat", fn: () => { state.tab = "chats"; state.chatId = c.id; state.contactCardId = null; renderTab(); } }); }
  all.push({ g: T("cmdk.actions"), label: T("cmdk.newChat"), icon: "plus", fn: go("connect") });
  all.push({ g: T("cmdk.actions"), label: T("cmdk.openSettings"), icon: "sliders", fn: go("settings") });
  for (const [th, k] of [["light", "cmdk.themeLight"], ["dark", "cmdk.themeDark"], ["auto", "cmdk.themeAuto"]]) all.push({ g: T("cmdk.actions"), label: T(k), icon: "palette", fn: () => { Store.theme = th; applyTheme(th); $$(".theme-seg button").forEach((b) => b.classList.toggle("active", b.dataset.theme === th)); } });
  try { for (const sk of Skins.LIST) all.push({ g: T("cmdk.actions"), label: T("cmdk.skin", { name: Skins.name(sk.id) }), icon: "palette", fn: () => Skins.set(sk.id) }); } catch (e) {}
  for (const cat of SETTINGS_CATEGORIES) all.push({ g: T("cmdk.settings"), label: T(cat.labelKey), icon: cat.icon, fn: () => { go("settings")(); openSettingsCategory(cat.id); } });
  const res = q ? all.filter((it) => it.label.toLowerCase().includes(q)) : all.filter((it) => it.g !== T("cmdk.settings")).slice(0, 12);
  return res.slice(0, 30);
}
function cmdkRender() {
  const input = $("#cmdk-input"), list = $("#cmdk-list"); if (!input || !list) return;
  __cmdkItems = cmdkBuildItems(input.value);
  if (__cmdkIdx >= __cmdkItems.length) __cmdkIdx = 0;
  list.innerHTML = "";
  __cmdkItems.forEach((it, i) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "sheet-action cmdk-item"; b.id = "cmdk-opt-" + i; b.setAttribute("role", "option"); b.setAttribute("aria-selected", i === __cmdkIdx ? "true" : "false");
    b.style.minHeight = "44px";
    b.innerHTML = (it.icon ? Icons.html(it.icon, 18) : "") + `<span class="cmdk-label">${escapeHtml(it.label)}</span><span class="fine muted cmdk-group">${escapeHtml(it.g)}</span>`;
    b.addEventListener("click", () => { closeCmdk(); it.fn(); });
    list.appendChild(b);
  });
  if (!__cmdkItems.length) list.innerHTML = `<p class="fine muted" style="padding:12px;">${escapeHtml(T("cmdk.none"))}</p>`;
  input.setAttribute("aria-activedescendant", __cmdkItems.length ? "cmdk-opt-" + __cmdkIdx : "");
}
function openCmdk() {
  const sheet = $("#cmdk"), input = $("#cmdk-input"); if (!sheet || !input) return;
  if (!sheet.classList.contains("hidden")) { closeCmdk(); return; }
  input.value = ""; __cmdkIdx = 0; cmdkRender();
  sheet.classList.remove("hidden"); setTimeout(() => { try { input.focus(); } catch (e) {} }, 0);
}
function closeCmdk() { const sheet = $("#cmdk"); if (sheet) sheet.classList.add("hidden"); }
function wireCmdk() {
  const input = $("#cmdk-input"); if (!input) return;
  input.addEventListener("input", () => { __cmdkIdx = 0; cmdkRender(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); if (!__cmdkItems.length) return;
      __cmdkIdx = (__cmdkIdx + (e.key === "ArrowDown" ? 1 : -1) + __cmdkItems.length) % __cmdkItems.length; cmdkRender();
      const o = $("#cmdk-opt-" + __cmdkIdx); if (o && o.scrollIntoView) o.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") { e.preventDefault(); const it = __cmdkItems[__cmdkIdx]; if (it) { closeCmdk(); it.fn(); } }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { const cs = $("#cmdk"); if (cs && !cs.classList.contains("hidden")) closeCmdk(); return; }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "k" || e.key === "K")) { if (!Store.myId) return; e.preventDefault(); openCmdk(); }
  });
}
function attachSwipeReply(el, m, c) {
  let startX = 0, startY = 0, swiping = false, thresholdCrossed = false;
  const isRtl = document.documentElement.dir === "rtl";
  const SWIPE_REPLY_THRESHOLD = 40; // в единицах уже отмасштабированного (dx*0.5) смещения — см. ниже
  el.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY; swiping = false; thresholdCrossed = false;
    el.style.transition = "none";
  }, { passive: true });
  el.addEventListener("touchmove", (e) => {
    const t = e.touches[0];
    let dx = t.clientX - startX;
    // В RTL естественный жест "ответить" — свайп ВЛЕВО (визуально к
    // началу строки), не вправо. dir="rtl" меняет визуальную сторону
    // текста/стрелок, но раньше не менял ожидаемое направление свайпа.
    if (isRtl) dx = -dx;
    const dy = Math.abs(t.clientY - startY);
    if (!swiping && Math.abs(dx) > 12 && Math.abs(dx) > dy) swiping = true;
    if (swiping && dx > 0) {
      const scaled = Math.min(dx * 0.5, 60);
      el.style.transform = `translateX(${(isRtl ? -1 : 1) * scaled}px)`;
      // Раньше о пороге "достаточно для ответа" пользователь узнавал
      // только ПОСЛЕ отпускания пальца (сработало/не сработало) — теперь
      // лёгкий haptic-тик + визуальный отклик (подсветка пузыря) ровно в
      // момент пересечения порога, один раз на жест, а не на каждый пиксель.
      const ready = scaled >= SWIPE_REPLY_THRESHOLD;
      if (ready && !thresholdCrossed) { thresholdCrossed = true; haptic("light"); el.classList.add("swipe-ready"); }
      else if (!ready && thresholdCrossed) { thresholdCrossed = false; el.classList.remove("swipe-ready"); }
    }
  }, { passive: true });
  el.addEventListener("touchend", () => {
    el.style.transition = "";
    el.classList.remove("swipe-ready");
    const tr = el.style.transform;
    el.style.transform = "";
    if (swiping && thresholdCrossed) {
      const m1 = tr && tr.match(/translateX\((-?\d+(?:\.\d+)?)px\)/);
      if (m1 && Math.abs(parseFloat(m1[1])) > SWIPE_REPLY_THRESHOLD) {
        state.replyTo = { msgId: m.id, text: m.text, from: m.from, authorName: m.from === "me" ? (Store.name || "") : (m.fromName || c.name || "") };
        showReplyBanner();
        const inp = $("#chat-input"); if (inp) inp.focus();
      }
    }
    swiping = false; thresholdCrossed = false;
  });
}
function updateScrollBottomButton() {
  const wrap = $("#chat-messages");
  const btn = $("#scroll-bottom-btn");
  if (!wrap || !btn) return;
  btn.classList.toggle("hidden", isNearBottom(wrap));
  // Раньше кружок-бейдж существовал в разметке, но никогда не
  // заполнялся — просто пустой видимый кружок в углу кнопки. Теперь
  // показывает реальное число непрочитанных, если чат ещё не долистан.
  const countEl = $("#scroll-bottom-count");
  const c = state.chatId ? state.contacts.get(state.chatId) : null;
  const n = c ? unreadCount(c) : 0;
  if (countEl) {
    if (n > 0) { countEl.textContent = n > 99 ? "99+" : String(n); countEl.classList.remove("hidden"); }
    else countEl.classList.add("hidden");
  }
  // Акцентный "↓ к новым" только когда реально есть непрочитанные выше —
  // просьба отличать от нейтрального "просто вернуться вниз".
  btn.classList.toggle("has-unread", n > 0);
  btn.setAttribute("aria-label", T(n > 0 ? "a11y.toNewMessages" : "a11y.toLast"));
}
function markThreadRead(c) {
  const toAck = [];
  for (const m of c.messages) if (m.from === "them" && !m.readAckSent) { m.readAckSent = true; startExpiryOnRead(m); toAck.push(m); }
  if (toAck.length && typeof Devices !== "undefined") { try { Devices.syncRead(c, toAck); } catch (e) {} } // «прочитано» синхронизируется на другие устройства аккаунта
  state.mentionedChats.delete(c.id); // весь тред помечен прочитанным выше — упоминания в нём больше не "непрочитанные"
  if (toAck.length === 0) return;
  persistContacts();
  // receiptsEnabled=false — не отправляем read-квитанции вовсе (но
  // readAckSent выше всё равно проставлен: это ЛОКАЛЬНЫЙ учёт для
  // счётчика непрочитанных, не сигнал собеседнику).
  if (Store.receiptsEnabled) {
    if (isGroup(c)) {
      // У группы нет своего mesh-линка — это набор отдельных P2P-связей с
      // каждым участником. sendAckBatch(groupId, ...) тут ничего не находит
      // (mesh.get(groupId) === undefined) и запись просто зависает в
      // pendingNoKey навсегда. Правильно — слать квитанцию РЕАЛЬНОМУ АВТОРУ
      // каждого сообщения (m.fromId), а не группе как единому адресату;
      // разные сообщения в одной группе могли написать разные люди.
      const byAuthor = new Map();
      for (const m of toAck) {
        const authorId = m.fromId; if (!authorId) continue;
        if (!byAuthor.has(authorId)) byAuthor.set(authorId, []);
        byAuthor.get(authorId).push(m.deliveryId || m.id);
      }
      for (const [authorId, ids] of byAuthor) sendAckBatch(authorId, ids, "read");
    } else {
      sendAckBatch(c.id, toAck.map((m) => m.deliveryId || m.id), "read");
    }
  }
  updateAppBadge();
  if (state.tab === "chats") renderChatsList();
}
function saveCurrentDraft() {
  if (!state.chatId) return;
  if (state.editingMessageId) return; // в поле сейчас правка чужого/своего сообщения, а не черновик — не сохраняем её как черновик
  const input = $("#chat-input"); if (!input) return;
  const v = input.value.trim();
  if (v) state.drafts[state.chatId] = v; else delete state.drafts[state.chatId];
  // Выход из чата — пишем ГАРАНТИРОВАННО синхронно (не через
  // scheduleDraftPersist), иначе на быстром уходе из чата отложенная
  // запись может не успеть сработать до размонтирования. Отменяем
  // отложенный вызов, чтобы не писать то же самое дважды.
  if (__draftPersistTimer) { clearTimeout(__draftPersistTimer); __draftPersistTimer = null; }
  persistDrafts();
}
// Внимание: .chat-input-bar двигается через transform — position: sticky у баннеров
// внутри/рядом с ним работать не будет; учитывайте это при добавлении sticky-элементов.
let __kbBaseH = 0;
// Нажатия на «+», эмодзи, камеру, скрепку, отправку и т.п. не должны убирать системную клавиатуру: кнопка перехватывает фокус у поля ввода.
// Отменяем сдвиг фокуса на mousedown и, если фокус всё-таки потерян, возвращаем его в поле сразу после действия.
function wireKeepKeyboard() {
  const sel = ".chat-input-bar button:not(#chat-emoji-btn)";
  let had = false;
  const inp = () => $("#chat-input");
  document.addEventListener("pointerdown", (e) => { had = document.activeElement === inp(); }, true);
  // Панель эмодзи выезжает вместо клавиатуры: при её открытии клавиатуру убираем
  document.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest("#chat-emoji-btn")) { const i = inp(); if (i && document.activeElement === i) i.blur(); }
  }, true);
  document.addEventListener("mousedown", (e) => {
    if (had && e.target.closest && e.target.closest(sel) && !e.target.closest("#emoji-search-input")) e.preventDefault();
  }, true);
  document.addEventListener("click", (e) => {
    if (!had || !e.target.closest || !e.target.closest(sel)) return;
    setTimeout(() => {
      const i = inp(); const ae = document.activeElement;
      const otherField = ae && ae !== document.body && ae !== i && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA");
      if (i && !i.disabled && !otherField && state.chatId) { try { i.focus({ preventScroll: true }); } catch (er) {} }
    }, 0);
  }, true);
}
function wireKeyboardFix() {
  if (!window.visualViewport) return;
  __kbBaseH = Math.round(window.visualViewport.height || window.innerHeight || 0);
  const vv = window.visualViewport;
  let kbWasOpen = false;
  // iOS при открытии клавиатуры НЕ меняет layout-viewport, а прокручивает visual viewport вверх (offsetTop > 0):
  // всё приложение "уезжало" наверх вместе с шапкой, а поле ввода дёргалось из-за собственного transform.
  // Теперь оболочка приложения привязывается к ВИДИМОЙ области: высота = vv.height, сдвиг = vv.offsetTop.
  // Шапка остаётся наверху видимой области, поле ввода — прямо над клавиатурой, переписка сжимается,
  // последние сообщения остаются на экране.
  function update() {
    const shell = document.getElementById("app-shell"); if (!shell) return;
    const root = document.documentElement;
    // Эталон «полной» высоты — максимум, который мы видели без клавиатуры (на iOS innerHeight иногда тоже уменьшается вместе с клавиатурой)
    const ae = document.activeElement;
    const typing = !!(ae && (ae.tagName === "TEXTAREA" || ae.tagName === "INPUT"));
    const layoutH = Math.max(window.innerHeight || 0, __kbBaseH);
    if (!typing && vv.height > __kbBaseH - 80) __kbBaseH = Math.max(__kbBaseH, Math.round(vv.height));
    const kbOpen = layoutH - vv.height > 100; // клавиатура — это >100px разницы; мелкие колебания (панель Safari) игнорируем
    if (kbOpen) {
      shell.style.height = Math.round(vv.height) + "px";
      shell.style.transform = vv.offsetTop > 0 ? "translateY(" + Math.round(vv.offsetTop) + "px)" : "";
      root.classList.add("kb-open"); // убирает нижнюю safe-area у таб-бара, пока клавиатура открыта
    } else {
      shell.style.height = ""; shell.style.transform = "";
      root.classList.remove("kb-open");
      // iOS после закрытия клавиатуры иногда оставляет страницу прокрученной — возвращаем в 0
      if (window.scrollY || vv.offsetTop) { try { window.scrollTo(0, 0); } catch (e) {} }
    }
    const wrap = document.getElementById("chat-messages");
    const chatVisible = wrap && !wrap.closest(".hidden");
    if (chatVisible && (kbOpen !== kbWasOpen || isNearBottom(wrap))) {
      requestAnimationFrame(() => { wrap.scrollTop = wrap.scrollHeight; });
    }
    kbWasOpen = kbOpen;
  }
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  // iOS анимирует клавиатуру ~300 мс и шлёт resize с опозданием — досчитываем несколько раз после фокуса
  document.addEventListener("focusin", () => { for (const d of [60, 200, 400, 700]) setTimeout(update, d); });
  // Страница не должна оставаться смещённой после ухода фокуса с поля ввода.
  document.addEventListener("focusout", () => setTimeout(() => {
    update();
    if (window.scrollY || (window.visualViewport && window.visualViewport.offsetTop && !document.documentElement.classList.contains("kb-open"))) { try { window.scrollTo(0, 0); } catch (e) {} }
  }, 80));
}

