"use strict";
// V.80: удобство. (1) Широкий десктопный макет >= 1100px: список чатов | переписка | панель контакта, без правок мобильного вида;
// (2) горячие клавиши (Ctrl+K — быстрый переход уже в 06-thread.js; здесь Ctrl+F, Esc, Alt+↑/↓); (3) приглашение из адресной книги
// через Contact Picker API (только на устройстве, без загрузки куда-либо); (4) доступность звонка: озвучка фаз и aria-pressed.

// ---------------- 1. Широкий макет ----------------
const WIDE_QUERY = "(min-width: 1100px) and (pointer: fine)";
let __wideMq = null;
function isWideLayout() {
  try { return !!(__wideMq && __wideMq.matches); } catch (e) { return false; }
}
function wideInfoHtmlTarget() { return $("#wide-info"); }
// Правая колонка: кто это, быстрые действия. Полная карточка по-прежнему открывается как раньше.
function renderWideInfo() {
  const box = wideInfoHtmlTarget(); if (!box) return;
  const c = state.chatId ? state.contacts.get(state.chatId) : null;
  if (!c) { box.classList.add("hidden"); box.innerHTML = ""; return; }
  box.classList.remove("hidden");
  box.innerHTML = "";
  const av = document.createElement("div"); av.className = "wide-info-avatar"; av.innerHTML = avatarCircleHtml(c, null, ""); box.appendChild(av);
  const h = document.createElement("h2"); h.textContent = c.name || T("sys.someone"); box.appendChild(h);
  const st = $("#chat-peer-status"); const p = document.createElement("p"); p.className = "fine muted"; p.textContent = st ? st.textContent : ""; box.appendChild(p);
  const mk = (id, key, fn) => { const b = document.createElement("button"); b.type = "button"; b.id = id; b.className = "btn-secondary"; b.textContent = T(key); b.addEventListener("click", fn); box.appendChild(b); };
  mk("wide-info-search", "chat.search", () => chatSearchShortcut());
  mk("wide-info-card", "wide.card", () => { try { openContactCard(c.id); } catch (e) {} });
}
// Вызывается после каждой отрисовки (renderTab): в широком режиме рядом с открытым чатом остаётся список слева и панель справа.
function wideSync() {
  const root = document.documentElement;
  const wide = isWideLayout();
  root.classList.toggle("wide", wide);
  const list = $("#screen-chats"), info = wideInfoHtmlTarget(), pick = $("#wide-empty");
  const chatOpen = wide && !!state.chatId;
  root.classList.toggle("wide-chat", chatOpen);
  if (list) list.classList.toggle("wide-pane", chatOpen);
  if (!wide) { if (info) info.classList.add("hidden"); if (pick) pick.classList.add("hidden"); return; }
  if (chatOpen) {
    if (list) { list.classList.remove("hidden"); try { renderChatsList(); } catch (e) {} }
    const cf = $("#chat-filters"); if (cf) cf.classList.remove("hidden");
    if (pick) pick.classList.add("hidden");
    renderWideInfo();
    $$("#chats-list .chat-row").forEach((r) => { const on = r.dataset.chatId === state.chatId; r.classList.toggle("active", on); if (on) r.setAttribute("aria-current", "true"); else r.removeAttribute("aria-current"); });
  } else {
    if (info) info.classList.add("hidden");
    const listShown = list && !list.classList.contains("hidden");
    if (pick) pick.classList.toggle("hidden", !(listShown && !state.contactCardId));
  }
}
function wireWideLayout() {
  if (typeof matchMedia !== "function") return;
  try { __wideMq = matchMedia(WIDE_QUERY); } catch (e) { return; }
  const on = () => { try { renderTab(); } catch (e) {} };
  if (__wideMq.addEventListener) __wideMq.addEventListener("change", on); else if (__wideMq.addListener) __wideMq.addListener(on);
  wideSync();
}

// ---------------- 2. Горячие клавиши ----------------
function chatSearchShortcut() {
  if (!state.chatId) { try { openGlobalSearch(); } catch (e) {} return; }
  const bar = $("#chat-search-bar"), inp = $("#chat-search-input"); if (!bar || !inp) return;
  bar.classList.remove("hidden");
  setTimeout(() => { try { inp.focus(); inp.select(); } catch (e) {} }, 0);
}
// Порядок чатов — как в видимом списке (после фильтров и закрепов)
function visibleChatIds() {
  try { renderChatsList(); } catch (e) {}
  return $$("#chats-list .chat-row").map((r) => r.dataset.chatId).filter(Boolean);
}
function switchChatBy(delta) {
  const ids = visibleChatIds(); if (!ids.length) return false;
  const i = ids.indexOf(state.chatId);
  const next = ids[i < 0 ? (delta > 0 ? 0 : ids.length - 1) : (i + delta + ids.length) % ids.length];
  if (!next || next === state.chatId) return false;
  try { saveCurrentDraft(); } catch (e) {}
  try { closeChatSearch(); } catch (e) {}
  try { cancelVoiceRecordingIfLeavingChat(next); } catch (e) {}
  state.multiSelect = null; state.contactCardId = null; state.tab = "chats";
  if (typeof resetChatTransientState === "function") resetChatTransientState(next);
  state.chatId = next; renderTab();
  announceToScreenReader((state.contacts.get(next) || {}).name || "");
  return true;
}
function overlayOpen() {
  if ($$(".sheet:not(.hidden)").length) return true;
  const cs = $("#call-screen"); if (cs && !cs.classList.contains("hidden")) return true;
  return false;
}
function onDesktopKey(e) {
  if (!Store.myId || e.isComposing) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.altKey && !e.shiftKey && (e.key === "f" || e.key === "F" || e.code === "KeyF")) {
    if (overlayOpen()) return;
    e.preventDefault(); chatSearchShortcut(); return;
  }
  if (e.altKey && !mod && !e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    if (overlayOpen()) return;
    if (switchChatBy(e.key === "ArrowDown" ? 1 : -1)) e.preventDefault();
    return;
  }
  if (e.key === "Escape" && !e.defaultPrevented && !mod && !e.altKey) {
    if (overlayOpen()) return; // шторки и звонок закрывают свои обработчики
    const bar = $("#chat-search-bar");
    if (state.chatId && bar && !bar.classList.contains("hidden")) { closeChatSearch(); return; }
    if (state.chatId && isWideLayout()) { closeChatSafely(); return; }
    if (state.contactCardId) { closeContactCardSafely(); return; }
  }
}

// ---------------- 3. Приглашение из адресной книги ----------------
// Contact Picker API есть не везде (Chrome на Android); на остальных кнопка скрыта, а «Пригласить друга» (системное меню «Поделиться»,
// ссылка, QR) работает как раньше. Выбранные контакты остаются на устройстве: приложение лишь открывает вашу почту или SMS с ссылкой.
function contactPickerSupported() {
  try { return typeof navigator !== "undefined" && !!navigator.contacts && typeof navigator.contacts.select === "function"; } catch (e) { return false; }
}
// Один выбранный контакт -> ссылки приглашения (чистая функция, без DOM)
function buildInviteLinks(contact, link, text) {
  const out = [];
  const body = (text ? text + " " : "") + link;
  const tel = (contact && Array.isArray(contact.tel) ? contact.tel : []).map((t) => String(t).replace(/[^\d+]/g, "")).filter((t) => t.replace(/\D/g, "").length >= 5)[0];
  const mail = (contact && Array.isArray(contact.email) ? contact.email : []).map((m) => String(m).trim()).filter((m) => /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/.test(m))[0];
  if (tel) out.push({ kind: "sms", href: "sms:" + tel + "?body=" + encodeURIComponent(body) });
  if (mail) out.push({ kind: "mail", href: "mailto:" + mail + "?subject=" + encodeURIComponent(T("app.name")) + "&body=" + encodeURIComponent(body) });
  return out;
}
function closeInviteContacts() { const sh = $("#invite-contacts-sheet"); if (sh) sh.classList.add("hidden"); }
function renderInviteContacts(list) {
  const sh = $("#invite-contacts-sheet"), box = $("#invite-contacts-list"); if (!sh || !box) return;
  box.innerHTML = "";
  const link = myAddLink(), text = T("firstRun.shareText");
  let shown = 0;
  for (const ct of list) {
    const name = ((Array.isArray(ct.name) ? ct.name[0] : ct.name) || "").toString().slice(0, 60);
    const links = buildInviteLinks(ct, link, text);
    if (!links.length) continue;
    shown++;
    const row = document.createElement("div"); row.className = "invite-contact-row";
    const nm = document.createElement("span"); nm.textContent = name || T("sys.someone"); row.appendChild(nm);
    for (const l of links) {
      const a = document.createElement("a"); a.className = "btn-secondary"; a.href = l.href; a.rel = "noopener";
      a.textContent = T(l.kind === "sms" ? "invite.sms" : "invite.email");
      a.setAttribute("aria-label", a.textContent + ": " + (name || ""));
      row.appendChild(a);
    }
    box.appendChild(row);
  }
  const empty = $("#invite-contacts-empty"); if (empty) empty.classList.toggle("hidden", shown > 0);
  sh.classList.remove("hidden");
  return shown;
}
async function pickContactsToInvite() {
  if (!contactPickerSupported()) { shareMyInviteLink(); return; }
  let picked;
  try { picked = await navigator.contacts.select(["name", "tel", "email"], { multiple: true }); }
  catch (e) { if (e && e.name !== "AbortError") toast(T("invite.pickFailed")); return; }
  if (!picked || !picked.length) return;
  renderInviteContacts(picked);
}
function wireInviteContacts() {
  const ok = contactPickerSupported();
  for (const id of ["connect-pick-contacts-btn", "onboarding-pick-contacts-btn"]) {
    const b = $("#" + id); if (!b) continue;
    b.classList.toggle("hidden", !ok);
    if (ok && !b.dataset.wired) { b.dataset.wired = "1"; b.addEventListener("click", () => pickContactsToInvite()); }
  }
}

// ---------------- 4. Доступность звонка ----------------
// Озвучка смены фазы звонка («Входящий», «Идёт разговор») и состояние переключателей для экранных дикторов.
function wireCallA11y() {
  if (typeof MutationObserver === "undefined") return;
  const phase = $("#call-phase");
  if (phase) {
    let last = "";
    new MutationObserver(() => {
      const t = (phase.textContent || "").trim();
      // секундомер активного звонка обновляется раз в секунду — озвучиваем только слова, а не цифры времени
      if (!t || t === last || /^\d{1,2}:\d{2}/.test(t)) return;
      last = t; const nm = $("#call-peer-name"); announceToScreenReader((nm && nm.textContent ? nm.textContent + ": " : "") + t);
    }).observe(phase, { childList: true, characterData: true, subtree: true });
  }
  for (const id of ["call-mute-btn", "call-speaker-btn", "call-video-btn"]) {
    const b = $("#" + id); if (!b) continue;
    const sync = () => b.setAttribute("aria-pressed", b.classList.contains("active") || b.classList.contains("muted") ? "true" : "false");
    sync();
    new MutationObserver(sync).observe(b, { attributes: true, attributeFilter: ["class"] });
  }
}

// ---------------- 5. Онбординг: меньше шагов ----------------
// Язык определён автоматически, поэтому сетку языков прячем за одной строкой (постепенное раскрытие); поле имени сразу в фокусе.
function paintOnboardingLangToggle() {
  const tog = $("#onboarding-lang-toggle"); if (!tog) return;
  const l = (I18N.languages || []).find((x) => x.code === I18N.current);
  tog.textContent = (l ? l.native : I18N.current) + " · " + T("onboarding.lang.change");
}
function wireOnboardingExtras() {
  const tog = $("#onboarding-lang-toggle"), more = $("#onboarding-lang-more");
  if (tog && more && !tog.dataset.wired) {
    tog.dataset.wired = "1";
    paintOnboardingLangToggle();
    tog.addEventListener("click", () => { const open = more.classList.toggle("hidden") === false; tog.setAttribute("aria-expanded", open ? "true" : "false"); });
    tog.setAttribute("aria-expanded", "false");
    tog.setAttribute("aria-controls", "onboarding-lang-more");
  }
  wireInviteContacts();
}

function wireDesktopUx() {
  wireWideLayout();
  wireCallA11y();
  wireInviteContacts();
  document.addEventListener("keydown", onDesktopKey);
}
