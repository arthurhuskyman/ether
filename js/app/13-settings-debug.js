"use strict";
// Часть 13 из 14 бывшего js/app.js: Настройки, отладка. Глобальная область общая; порядок <script> важен.

// =====================================================================
// Поиск
// =====================================================================
function wireSearchHandlers() {
  const gs = $("#global-search");
  if (gs) gs.addEventListener("input", (e) => { state.searchQuery = e.target.value.trim(); renderChatsList(); });
  const ta = $("#toggle-archived");
  if (ta) ta.addEventListener("click", () => { state.showArchived = !state.showArchived; renderChatsList(); });
  const ei = $("#chats-empty-invite-btn"); // V.79: единственное главное действие пустого списка чатов
  if (ei) ei.addEventListener("click", () => { shareMyInviteLink(); });
  $$("#chat-filters .chat-filter-chip[data-filter]").forEach((chip) => { // кнопка «+» (папки) без data-filter — не фильтр
    chip.addEventListener("click", () => {
      const f = chip.dataset.filter || "all";
      $$("#chat-filters .chat-filter-chip").forEach((b) => b.classList.toggle("active", b === chip));
      if (f === "calls") {
        // "Звонки" — не отдельный таб и не отдельный сегмент-переключатель
        // над списком (было двойной навигацией), а такой же чип, как
        // All/Unread/Groups/Direct. Внутреннее состояние chatsSegment
        // оставлено как есть — его читает renderTab()/renderCallsList().
        state.chatsSegment = "calls";
        markMissedCallsSeen();
        renderTab();
      } else {
        state.chatsSegment = "chats";
        state.chatFilter = f;
        renderTab(); // из «Звонков» нужно заново показать список чатов, а не только перерисовать его скрытым
      }
    });
  });
  const csb = $("#chat-search-btn");
  if (csb) csb.addEventListener("click", () => {
    const bar = $("#chat-search-bar"); if (!bar) return;
    bar.classList.toggle("hidden");
    if (!bar.classList.contains("hidden")) setTimeout(() => { const i = $("#chat-search-input"); if (i) i.focus(); }, 50);
    else closeChatSearch();
  });
  const csc = $("#chat-search-close");
  if (csc) csc.addEventListener("click", closeChatSearch);
  const csi = $("#chat-search-input");
  if (csi) csi.addEventListener("input", (e) => { state.chatSearchQuery = e.target.value.trim(); renderChatThread(); updateSearchCounter(); });
}
function closeChatSearch() {
  state.chatSearchQuery = "";
  // Сбрасываем отложенный скролл к первому попаданию — иначе ранее
  // поставленный таймер сработает уже после закрытия поиска (или
  // всего чата) и попытается прокрутить #chat-messages, которого к
  // этому моменту может не быть на экране вовсе.
  if (__chatSearchScrollTimer) { clearTimeout(__chatSearchScrollTimer); __chatSearchScrollTimer = null; }
  const input = $("#chat-search-input"); if (input) input.value = "";
  const bar = $("#chat-search-bar"); if (bar) bar.classList.add("hidden");
  const counter = $("#chat-search-counter"); if (counter) counter.textContent = "";
}
function updateSearchCounter() {
  const c = state.contacts.get(state.chatId); if (!c) return;
  const q = state.chatSearchQuery.toLowerCase();
  const el = $("#chat-search-counter"); if (!el) return;
  if (!q) { el.textContent = ""; return; }
  const n = c.messages.filter((m) => (m.text || "").toLowerCase().includes(q)).length;
  el.textContent = n > 0 ? String(n) : "—";
}

// =====================================================================
// Настройки
// =====================================================================
// Раздел 9 роадмапа — категории с back-навигацией. category-hidden — своя
// отдельная от search-hidden CSS-подсветка (идентичное правило
// `display:none`, но другой класс): существующий обработчик поиска ниже
// снимает search-hidden с ВСЕХ групп, когда поле очищается (строка
// `q.length > 0 && !anyVisible`) — если бы категории прятались тем же
// классом, очистка поиска случайно показывала бы разом все категории.
// «Часто используемые»: 6 плиток над списком категорий (тема, скин, звуки, уведомления, PIN, резервная копия).
// Переключатели нажимают настоящие элементы настроек (их обработчики и проверки те же), переходы открывают нужную категорию.
const SETTINGS_QUICK = [
  { id: "theme", icon: "palette", labelKey: "settings.quick.theme", kind: "cycle" },
  { id: "skin", icon: "sparkle", labelKey: "settings.quick.skin", kind: "go", cat: "appearance", target: ".skin-row" },
  { id: "sounds", icon: "volume", labelKey: "settings.quick.sounds", kind: "toggle", input: "#settings-sounds" },
  { id: "notifications", icon: "bell", labelKey: "settings.quick.notifications", kind: "toggle", input: "#settings-notifications" },
  { id: "pin", icon: "shield", labelKey: "settings.quick.pin", kind: "toggle", input: "#settings-pinlock" },
  { id: "backup", icon: "database", labelKey: "settings.quick.backup", kind: "go", cat: "data", target: "#settings-export-backup-btn" },
  { id: "uimode", icon: "sliders", labelKey: "ui.simple.title", kind: "uimode" }, // V.79: переключатель простого/полного режима
];
function settingsQuickHtml() {
  return `<div class="settings-quick" role="group" aria-label="${escapeHtml(T("settings.quick.title"))}"><h3 class="settings-quick-title">${escapeHtml(T("settings.quick.title"))}</h3><div class="settings-quick-grid">` +
    SETTINGS_QUICK.map((q) => `<button type="button" class="settings-quick-tile" data-quick="${q.id}"${q.kind === "go" ? "" : ' aria-pressed="false"'}><span class="settings-quick-icon">${Icons.html(q.icon, 22)}</span><span class="settings-quick-label">${escapeHtml(T(q.labelKey))}</span><span class="settings-quick-state" aria-hidden="true"></span></button>`).join("") + `</div></div>`;
}
function refreshSettingsQuick() {
  $$("#settings-category-list .settings-quick-tile").forEach((b) => {
    const q = SETTINGS_QUICK.find((x) => x.id === b.dataset.quick); if (!q) return;
    const st = b.querySelector(".settings-quick-state");
    if (q.kind === "toggle") {
      const on = q.id === "sounds" ? Store.soundsEnabled : q.id === "notifications" ? Store.notificationsEnabled : Store.pinEnabled;
      b.setAttribute("aria-pressed", on ? "true" : "false"); b.classList.toggle("on", !!on);
      if (st) st.textContent = T(on ? "settings.quick.on" : "settings.quick.off");
    } else if (q.kind === "uimode") {
      const on = isSimpleUi();
      b.setAttribute("aria-pressed", on ? "true" : "false"); b.classList.toggle("on", on);
      if (st) st.textContent = T(on ? "ui.simple.on" : "ui.simple.off");
    } else if (q.kind === "cycle") {
      const th = Store.theme; b.classList.remove("on");
      if (st) st.textContent = T("settings.theme." + (["light", "dark", "oled", "auto"].includes(th) ? th : "auto"));
    }
  });
}
// D1: единый сброс состояния, привязанного к ОТКРЫТОМУ чату (ответ/правка/поиск/мультивыбор/запись голосового).
// Вызывать перед любой прямой сменой state.chatId в обход closeChatSafely(), иначе цитата/правка из чата A уйдёт в чат B.
function resetChatTransientState(nextId) {
  const next = nextId == null ? null : nextId;
  if (next !== null && next === state.chatId) return; // тот же чат — ничего не сбрасываем
  try { cancelVoiceRecordingIfLeavingChat(next); } catch (e) {}
  try { cancelEditing(); } catch (e) {}
  try { cancelReply(); } catch (e) {}
  try { closeChatSearch(); } catch (e) {}
  state.multiSelect = null;
}
function onSettingsQuick(id) {
  const q = SETTINGS_QUICK.find((x) => x.id === id); if (!q) return;
  if (q.kind === "uimode") { UiMode.toggle(); toast(T(isSimpleUi() ? "ui.simple.on" : "ui.simple.off") + ": " + T("ui.simple.title")); return; }
  if (q.kind === "toggle") { const cb = $(q.input); if (cb) cb.click(); setTimeout(() => { try { refreshSettingsQuick(); } catch (e) {} }, 350); }
  else if (q.kind === "cycle") {
    const order = ["light", "dark", "oled", "auto"], cur = Store.theme, next = order[(order.indexOf(cur) + 1) % order.length];
    Store.theme = next; applyTheme(next); $$(".theme-seg button").forEach((b) => b.classList.toggle("active", b.dataset.theme === next)); refreshSettingsQuick();
  } else {
    openSettingsCategory(q.cat);
    setTimeout(() => { const el = $(q.target); if (el && el.scrollIntoView) { try { el.scrollIntoView({ block: "center" }); } catch (e) {} } }, 50);
  }
}
// «Дополнительно»: редкие строки (data-settings-adv в разметке) свёрнуты по умолчанию, состояние по категориям запоминается.
// Пока идёт поиск, свёрнутое показывается (класс settings-searching на экране), чтобы настройки находились и там.
const SETTINGS_ADV_KEY = "ether.settingsAdv";
function loadSettingsAdv() { try { const v = JSON.parse(localStorage.getItem(SETTINGS_ADV_KEY) || "{}"); return v && typeof v === "object" ? v : {}; } catch (e) { return {}; } }
function setSettingsAdv(cat, open) { const v = loadSettingsAdv(); if (open) v[cat] = true; else delete v[cat]; try { localStorage.setItem(SETTINGS_ADV_KEY, JSON.stringify(v)); } catch (e) {} }
function settingsAdvCat(el) { const g = el.closest("[data-settings-category]"); return g ? g.dataset.settingsCategory : ""; }
function applySettingsAdv() {
  const open = loadSettingsAdv(), screen = $("#screen-settings"); if (!screen) return;
  const present = new Set(), simple = isSimpleUi();
  // data-settings-adv — редкие строки всегда; data-settings-full — строки, уходящие под «Дополнительно» только в простом режиме (V.79)
  screen.querySelectorAll("[data-settings-adv],[data-settings-full]").forEach((el) => {
    if (!el.hasAttribute("data-settings-adv") && !simple) { el.classList.remove("adv-collapsed"); return; }
    const cat = settingsAdvCat(el); present.add(cat); el.classList.toggle("adv-collapsed", !open[cat]);
  });
  let box = $("#settings-adv-toggles");
  if (!box) { box = document.createElement("div"); box.id = "settings-adv-toggles"; screen.appendChild(box); }
  if (!box.dataset.built) {
    box.dataset.built = "1";
    box.innerHTML = SETTINGS_CATEGORIES.map((c) => `<button type="button" class="settings-adv-toggle category-hidden" data-adv-cat="${c.id}" aria-expanded="false"><span class="settings-adv-label">${escapeHtml(T("settings.advanced"))}</span><span class="chevron">${Icons.html("chevron-down", 16)}</span></button>`).join("");
    box.addEventListener("click", (e) => {
      const b = e.target.closest(".settings-adv-toggle"); if (!b) return;
      setSettingsAdv(b.dataset.advCat, !loadSettingsAdv()[b.dataset.advCat]); applySettingsAdv(); updateSettingsCategoryView();
    });
  }
  box.__present = present;
  box.querySelectorAll(".settings-adv-toggle").forEach((b) => { const o = !!open[b.dataset.advCat]; b.setAttribute("aria-expanded", o ? "true" : "false"); b.classList.toggle("open", o); });
}
function renderSettingsCategories() {
  const list = $("#settings-category-list"); if (!list) return;
  list.innerHTML = settingsQuickHtml() + SETTINGS_CATEGORIES.map((cat) => `
    <button type="button" class="settings-category-row" data-category="${cat.id}">
      <span class="settings-category-icon">${Icons.html(cat.icon, 20)}</span>
      <span class="settings-category-label">${escapeHtml(T(cat.labelKey))}</span>
      <span class="chevron">${Icons.html("chevron-right", 16)}</span>
    </button>`).join("");
  list.querySelectorAll(".settings-category-row").forEach((btn) => {
    btn.addEventListener("click", () => openSettingsCategory(btn.dataset.category));
  });
  list.querySelectorAll(".settings-quick-tile").forEach((btn) => btn.addEventListener("click", () => onSettingsQuick(btn.dataset.quick)));
  refreshSettingsQuick();
}
function openSettingsCategory(id) {
  state.settingsCategory = id;
  updateSettingsCategoryView();
}
function closeSettingsCategory() {
  state.settingsCategory = null;
  updateSettingsCategoryView();
}
// Поиск (ниже) работает по-прежнему ПО ВСЕМУ экрану Settings, а не внутри
// одной категории — это сознательно: при вводе запроса пользователь хочет
// найти нужную настройку, а не сначала угадать, в какой категории она
// живёт. Поэтому во время поиска категории временно не участвуют:
// показываются все группы, фильтрация идёт только через search-hidden,
// как и раньше. Категория, что была открыта до начала поиска, никуда не
// теряется — просто не применяется, пока в поле есть текст, и
// восстанавливается сама собой, как только поле очищается (state
// category мы здесь не трогаем).
function updateSettingsCategoryView() {
  const searchEl = $("#settings-search");
  const searching = !!(searchEl && searchEl.value.trim());
  const list = $("#settings-category-list");
  const header = $("#settings-category-header");
  const groups = $$("#screen-settings .settings-group");
  const scr = $("#screen-settings"); if (scr) scr.classList.toggle("settings-searching", searching);
  try { applySettingsAdv(); refreshSettingsQuick(); } catch (e) {}
  const advBox = $("#settings-adv-toggles");
  $$("#settings-adv-toggles .settings-adv-toggle").forEach((b) => b.classList.toggle("category-hidden", searching || b.dataset.advCat !== state.settingsCategory || !(advBox && advBox.__present && advBox.__present.has(b.dataset.advCat))));
  if (searching) {
    if (list) list.classList.add("hidden");
    if (header) header.classList.add("hidden");
    groups.forEach((g) => { g.classList.remove("category-hidden"); g.classList.remove("fx-advanced-collapsed"); }); // при поиске расширенные эффекты тоже ищутся
    return;
  }
  if (!state.settingsCategory) {
    if (list) list.classList.remove("hidden");
    if (header) header.classList.add("hidden");
    groups.forEach((g) => g.classList.add("category-hidden"));
    return;
  }
  if (list) list.classList.add("hidden");
  if (header) {
    header.classList.remove("hidden");
    const cat = SETTINGS_CATEGORIES.find((c) => c.id === state.settingsCategory);
    const titleEl = $("#settings-category-title");
    if (titleEl) titleEl.textContent = cat ? T(cat.labelKey) : "";
  }
  groups.forEach((g) => g.classList.toggle("category-hidden", g.dataset.settingsCategory !== state.settingsCategory));
}
// Своё фото: выбирается в Настройки → Профиль, сжимается до 160×160 JPEG и рассылается контактам вместе с настройками приватности
// (см. sendPrivacyPrefsTo) — у собеседника оно показывается, пока он не выбрал вам своё.
function renderProfileAvatar() {
  const b = $("#settings-avatar-btn"); if (!b) return;
  const av = Store.myAvatar;
  if (av && AVATAR_DATAURL_RE.test(av)) { b.style.background = ""; b.style.backgroundImage = `url('${av}')`; b.textContent = ""; }
  else { b.style.backgroundImage = ""; b.style.background = avatarGradient(Store.name); b.textContent = initials(Store.name); }
  const rm = $("#settings-avatar-remove"); if (rm) rm.classList.toggle("hidden", !av);
}
function wireProfileAvatar() {
  const btn = $("#settings-avatar-btn"), change = $("#settings-avatar-change"), rm = $("#settings-avatar-remove"), input = $("#settings-avatar-input");
  if (!input || input.dataset.wired) return;
  input.dataset.wired = "1";
  const pick = () => input.click();
  if (btn) btn.addEventListener("click", pick);
  if (change) change.addEventListener("click", pick);
  input.addEventListener("change", async () => {
    const file = input.files && input.files[0]; input.value = "";
    if (!file) return;
    try { Store.myAvatar = await readImageAsAvatarDataUrl(file); renderProfileAvatar(); toast(T("toast.avatarUpdated")); }
    catch (e) { toast(T("toast.avatarFailed")); }
  });
  if (rm) rm.addEventListener("click", () => { Store.myAvatar = ""; renderProfileAvatar(); });
  renderProfileAvatar();
}
let __settingsWired = false;
function wireSettingsScreen() {
  if (__settingsWired) return; // повторный вызов (например, после смены языка или повторного входа) не должен вешать обработчики дважды
  __settingsWired = true;
  renderSettingsCategories();
  wireProfileAvatar();
  updateSettingsCategoryView();
  const backBtn = $("#settings-back-btn");
  if (backBtn) backBtn.addEventListener("click", closeSettingsCategory);
  const settingsSearch = $("#settings-search");
  if (settingsSearch) {
    // Нюанс (как и предупреждал ревьюер): .settings-row.column — это
    // контейнер с несколькими подэлементами (например, Privacy), а не
    // одна строка с одним текстом — простая фильтрация по textContent
    // всё равно работает приемлемо (ищет по всему тексту внутри), не
    // идеально для таких составных блоков, но этого достаточно для
    // первой версии.
    settingsSearch.addEventListener("input", (e) => {
      // Отдельный класс search-hidden, а не общий "hidden" — часть строк
      // (например #change-pin-btn) уже скрыта своей собственной логикой
      // независимо от поиска; трогать их общий "hidden" напрямую стёрло
      // бы это состояние при очистке поля поиска.
      const q = e.target.value.trim().toLowerCase();
      $$("#screen-settings .settings-row").forEach((row) => {
        const text = (row.textContent || "").toLowerCase();
        row.classList.toggle("search-hidden", q.length > 0 && !text.includes(q));
      });
      $$("#screen-settings .settings-group").forEach((group) => {
        const anyVisible = Array.from(group.querySelectorAll(".settings-row")).some((r) => !r.classList.contains("search-hidden") && !r.classList.contains("hidden"));
        group.classList.toggle("search-hidden", q.length > 0 && !anyVisible);
      });
      // Поиск временно "снимает" категории (см. комментарий у
      // updateSettingsCategoryView) — пересчитываем после своей логики
      // выше, а не вместо неё.
      updateSettingsCategoryView();
    });
  }
  const helpBtn = $("#help-btn");
  if (helpBtn) helpBtn.addEventListener("click", () => {
    renderHelp();
    const el = $("#help-sheet"); if (el) el.classList.remove("hidden");
  });
  // Тот же export/importBackup, что в Debug — только точка входа теперь
  // на виду, а не спрятана в скрытом экране, куда обычный пользователь
  // никогда не попадёт (5 тапов по заголовку). #import-backup-input —
  // один и тот же file input на двух кнопках (Debug и Settings).
  const favBtn = $("#settings-favorites-btn");
  if (favBtn) favBtn.addEventListener("click", openFavoritesSheet);
  const sExpBackup = $("#settings-export-backup-btn");
  if (sExpBackup) sExpBackup.addEventListener("click", exportBackup);
  const sImpBackup = $("#settings-import-backup-btn");
  if (sImpBackup) sImpBackup.addEventListener("click", () => { const el = $("#import-backup-input"); if (el) el.click(); });
  // killer-features-backlog 0.2 — "свой сервер" как оформленная фича:
  // просто объяснение + готовая команда, без реального провижининга
  // (странице неоткуда развернуть чужой сервер) — честные рамки того,
  // что клиент вообще может сделать.
  const selfHostBtn = $("#self-host-info-btn");
  if (selfHostBtn) selfHostBtn.addEventListener("click", () => {
    const sheet = $("#self-host-sheet"); if (sheet) sheet.classList.remove("hidden");
  });
  // killer-features-backlog 0.5 — Dead Man's Switch настройки.
  const dmEnabledEl = $("#settings-deadman-enabled");
  if (dmEnabledEl) dmEnabledEl.addEventListener("change", (e) => {
    if (e.target.checked && !Store.deadManContactId) {
      e.target.checked = false;
      toast(T("toast.deadManNeedsContact"));
      return;
    }
    Store.deadManEnabled = e.target.checked;
    if (e.target.checked) checkDeadManSwitch();
  });
  const dmThresholdEl = $("#settings-deadman-threshold");
  if (dmThresholdEl) dmThresholdEl.addEventListener("change", (e) => { Store.deadManThresholdDays = parseInt(e.target.value, 10) || 7; });
  const dmContactBtn = $("#settings-deadman-contact-btn");
  if (dmContactBtn) dmContactBtn.addEventListener("click", () => {
    openForwardSheet((contactId) => {
      Store.deadManContactId = contactId;
      const nameEl2 = $("#settings-deadman-contact-name");
      const c = state.contacts.get(contactId);
      if (nameEl2) nameEl2.textContent = c ? (c.name || T("sys.someone")) : "";
    }, "settings.deadMan.contact.pick");
  });
  // killer-features-backlog 1.7 — Panic Clean (встряхнуть телефон).
  const panicShakeEl = $("#settings-panic-shake");
  if (panicShakeEl) {
    if (typeof DeviceMotionEvent === "undefined") {
      const row = $("#settings-panic-shake-row"); if (row) row.classList.add("hidden");
    } else {
      panicShakeEl.addEventListener("change", async (e) => {
        if (e.target.checked) {
          const granted = await requestMotionPermissionIfNeeded();
          if (!granted) { e.target.checked = false; toast(T("toast.motionPermissionDenied")); return; }
          Store.panicShakeEnabled = true;
          wirePanicShake();
        } else {
          Store.panicShakeEnabled = false;
          unwirePanicShake();
        }
      });
    }
  }
  const nameEl = $("#settings-name");
  if (nameEl) nameEl.addEventListener("change", (e) => {
    const v = e.target.value.trim();
    if (v) {
      Store.name = v; try { if (mesh) mesh.localName = v; } catch (e) {} toast(T("toast.nameUpdated")); renderProfileAvatar(); // новые соединения представляются уже новым именем
      // initSignaling() полностью пересоздаёт WebSocket — если сейчас идёт
      // звонок, лучше не рисковать кратким окном недоступности сигналинга
      // (может понадобиться ICE restart и т.п.) ради обновления имени.
      // Сервер узнает новое имя при следующем естественном переподключении.
      if (!state.callId) initSignaling();
    }
  });
  const hideNotifEl = $("#settings-hide-notif");
  if (hideNotifEl) hideNotifEl.addEventListener("change", (e) => { Store.hideNotifContent = e.target.checked; });
  const myStatusEl = $("#settings-my-status");
  if (myStatusEl) myStatusEl.addEventListener("change", (e) => { Store.myStatus = e.target.value.trim().slice(0, 80); });
  const idEl = $("#settings-identity");
  if (idEl) {
    idEl.addEventListener("input", () => {
      const v = idEl.value.trim();
      if (!v) { idEl.classList.remove("input-invalid"); return; }
      Identity.idFor(v).then(
        () => idEl.classList.remove("input-invalid"),
        () => idEl.classList.add("input-invalid")
      );
    });
    idEl.addEventListener("change", async (e) => {
      const v = e.target.value.trim(); if (!v) return;
      try {
        const identity = await Identity.idFor(v);
        let newId = identity.id;
        try { newId = (await deriveOnboardingId(identity)).id; } catch (e2) { etherLog("warn", "[idv2] вывод id v2 не удался:", String(e2)); } // новый номер сразу в id v2
        try { discoveryUnpublishBeforeIdChange(); } catch (e2) {}
        Store.myIdentityRaw = identity.normalized;
        Store.myId = newId;
        try { localStorage.removeItem("ether.idMig"); if (Identity.isV2(newId)) idMigUpdate((m) => { m.done = true; m.fresh = true; m.at = Date.now(); }); } catch (e2) {} // ручная смена номера: прежняя миграция и алиас больше не относятся к этому id
        try { Ratchet.resetAll(); } catch (e2) {} // сессии привязаны к паре id: со старым id они бесполезны
        try { envelopeCache.clear(); } catch (e2) {}
        idEl.classList.remove("input-invalid");
        toast(T("toast.idUpdated"));
        initSignaling();
      } catch (err) { toast(T(err.message)); e.target.value = Store.myIdentityRaw; idEl.classList.remove("input-invalid"); }
    });
  }
  const save = $("#save-signaling-btn");
  if (save) save.addEventListener("click", () => {
    const el = $("#settings-signaling-url");
    if (el) Store.signalingUrl = el.value.trim();
    initSignaling(); toast(T("toast.saved"));
  });
  const disc = $("#settings-discoverable");
  if (disc) disc.addEventListener("change", (e) => {
    Store.discoverable = e.target.checked; initSignaling();
  });
  const rcpt = $("#settings-receipts");
  if (rcpt) rcpt.addEventListener("change", (e) => { Store.receiptsEnabled = e.target.checked; });
  const lsv = $("#settings-last-seen");
  if (lsv) lsv.addEventListener("change", (e) => { Store.lastSeenVisible = e.target.checked; });
  const pv = $("#settings-presence");
  if (pv) pv.addEventListener("change", (e) => { Store.presenceVisible = e.target.checked; });
  try { wireDiscoveryUI(); } catch (e) { etherLog("error", "[discovery]", String(e)); }
  const rvc = $("#settings-require-verified");
  if (rvc) { rvc.checked = Store.requireVerifiedCalls; rvc.addEventListener("change", () => { Store.requireVerifiedCalls = rvc.checked; }); }
  const qOn = $("#settings-quiet-on"), qFrom = $("#settings-quiet-from"), qTo = $("#settings-quiet-to"), qRow = $("#settings-quiet-times");
  const syncQuiet = () => { if (qRow) qRow.classList.toggle("hidden", !Store.quietOn); };
  if (qOn) { qOn.checked = Store.quietOn; qOn.addEventListener("change", () => { Store.quietOn = qOn.checked; syncQuiet(); }); }
  if (qFrom) { qFrom.value = Store.quietFrom; qFrom.addEventListener("change", () => { Store.quietFrom = qFrom.value; }); }
  if (qTo) { qTo.value = Store.quietTo; qTo.addEventListener("change", () => { Store.quietTo = qTo.value; }); }
  syncQuiet();
  const sounds = $("#settings-sounds");
  if (sounds) sounds.addEventListener("change", (e) => {
    Store.soundsEnabled = e.target.checked;
  });
  const autoEmoji = $("#settings-auto-emoji");
  if (autoEmoji) autoEmoji.addEventListener("change", (e) => {
    Store.autoEmoji = e.target.checked;
  });
  const ringtoneSel = $("#settings-ringtone");
  if (ringtoneSel) {
    ringtoneSel.value = Store.ringtone;
    ringtoneSel.addEventListener("change", (e) => { Store.ringtone = e.target.value; });
  }
  const ringtonePreview = $("#settings-ringtone-preview");
  if (ringtonePreview) ringtonePreview.addEventListener("click", () => {
    try {
      const el = getSoundEl(currentRingtoneSrc(), false);
      el.currentTime = 0;
      const p = el.play();
      if (p && p.catch) p.catch(() => {});
      setTimeout(() => { try { el.pause(); el.currentTime = 0; } catch (e) {} }, 3000);
    } catch (e) {}
  });
  const linkPreviews = $("#settings-link-previews");
  if (linkPreviews) linkPreviews.addEventListener("change", (e) => {
    Store.linkPreviewMode = e.target.value;
    if (state.chatId) renderChatThread();
  });
  const translateEndpointEl = $("#settings-translate-endpoint");
  if (translateEndpointEl) translateEndpointEl.addEventListener("change", (e) => {
    Store.translateEndpoint = e.target.value;
    e.target.value = Store.translateEndpoint; // пустое поле возвращает адрес по умолчанию
  });
  const translateKeyEl = $("#settings-translate-key");
  if (translateKeyEl) translateKeyEl.addEventListener("change", (e) => { Store.translateApiKey = e.target.value; });
  let pinSheetMode = "new"; // "new" | "verify-old" | "enter-new" | "disable"
  function updateChangePinBtnVisibility() {
    const btn = $("#change-pin-btn"); if (btn) btn.classList.toggle("hidden", !Store.pinEnabled);
  }
  updateChangePinBtnVisibility();
  const pinlock = $("#settings-pinlock");
  if (pinlock) pinlock.addEventListener("change", (e) => {
    if (e.target.checked) {
      pinSheetMode = "new";
      const st = $("#set-pin-title"); if (st) st.textContent = T("pin.newTitle");
    } else {
      pinSheetMode = "disable";
      const st = $("#set-pin-title"); if (st) st.textContent = T("pin.confirmTitle");
    }
    const si = $("#set-pin-input"); if (si) si.value = "";
    const ss = $("#set-pin-sheet"); if (ss) ss.classList.remove("hidden");
    setTimeout(() => { const i = $("#set-pin-input"); if (i) i.focus(); }, 50);
  });
  const changePinBtn = $("#change-pin-btn");
  if (changePinBtn) changePinBtn.addEventListener("click", () => {
    pinSheetMode = "verify-old";
    const st = $("#set-pin-title"); if (st) st.textContent = T("pin.confirmTitle");
    const si = $("#set-pin-input"); if (si) si.value = "";
    const ss = $("#set-pin-sheet"); if (ss) ss.classList.remove("hidden");
    setTimeout(() => { const i = $("#set-pin-input"); if (i) i.focus(); }, 50);
  });
  // Шифрование данных на устройстве (js/secure-store.js): включается и выключается только с подтверждением PIN
  const encToggle = $("#settings-encrypt-store");
  const syncEncUi = () => { if (encToggle) { encToggle.checked = SecureStore.isOn(); encToggle.disabled = !Store.pinEnabled && !SecureStore.isOn(); } };
  syncEncUi();
  if (encToggle) encToggle.addEventListener("change", () => {
    if (!Store.pinEnabled) { encToggle.checked = false; toast(T("secure.needPin")); return; }
    pinSheetMode = encToggle.checked ? "encrypt-enable" : "encrypt-disable";
    const st = $("#set-pin-title"); if (st) st.textContent = T(encToggle.checked ? "secure.enableTitle" : "pin.confirmTitle");
    const si = $("#set-pin-input"); if (si) si.value = "";
    const ss = $("#set-pin-sheet"); if (ss) ss.classList.remove("hidden");
    setTimeout(() => { const i = $("#set-pin-input"); if (i) i.focus(); }, 50);
  });
  let pinOldValue = "";
  // Шторку PIN можно закрыть отменой, фоном или Esc — тогда переключатели («PIN при запуске», «Шифровать данные») должны вернуться
  // к реальному состоянию, а не показывать «включено» там, где ничего не включилось
  const pinSheetEl = $("#set-pin-sheet");
  if (pinSheetEl && typeof MutationObserver !== "undefined") new MutationObserver(() => {
    if (!pinSheetEl.classList.contains("hidden")) return;
    if (pinlock) pinlock.checked = Store.pinEnabled;
    syncEncUi(); pinOldValue = "";
  }).observe(pinSheetEl, { attributes: true, attributeFilter: ["class"] });
  const pinSave = $("#set-pin-save-btn");
  let pinSaveBusy = false; // два параллельных клика (rekey/enable/disable) портили бы хранилище
  const pinSaveRun = async () => {
    const inp = $("#set-pin-input"); if (!inp) return;
    const v = inp.value.trim();
    if (!v || v.length < 4) { toast(T("toast.pinShort")); return; }
    if (!/^\d+$/.test(v)) { toast(T("toast.pinDigits")); return; }

    if (pinSheetMode === "encrypt-enable" || pinSheetMode === "encrypt-disable") {
      const h = await pbkdf2Hex(v, Store.pinSalt, PIN_ITERATIONS);
      if (h !== Store.pinHash) { toast(T("toast.pinWrong")); return; }
      const ss = $("#set-pin-sheet");
      try {
        if (pinSheetMode === "encrypt-enable") {
          if (v.length < SecureStore.MIN_PIN) { toast(T("secure.pinShort", { n: SecureStore.MIN_PIN })); return; }
          if (ss) ss.classList.add("hidden");
          toast(T("secure.working"));
          await SecureStore.enable(v);
          await backupToIDB();
          await migrateFilesEncryption(true);
          toast(T("secure.on"));
        } else {
          if (ss) ss.classList.add("hidden");
          toast(T("secure.working"));
          await migrateFilesEncryption(false);
          await SecureStore.disable(v);
          await backupToIDB();
          toast(T("secure.off"));
        }
      } catch (e) { etherLog("error", "[secure]", String(e)); toast(T("secure.failed")); }
      syncEncUi();
      return;
    }

    if (pinSheetMode === "new") {
      Store.pinSalt = randomSaltHex(16);
      Store.pinHash = await pbkdf2Hex(v, Store.pinSalt, PIN_ITERATIONS);
      Store.pinEnabled = true;
      updateChangePinBtnVisibility();
      const ss = $("#set-pin-sheet"); if (ss) ss.classList.add("hidden");
      toast(T("toast.pinOn"));
      return;
    }
    if (pinSheetMode === "disable") {
      const h = await pbkdf2Hex(v, Store.pinSalt, PIN_ITERATIONS);
      if (h !== Store.pinHash) { toast(T("toast.pinWrong")); return; }
      if (SecureStore.isOn()) { toast(T("secure.offFirst")); const ss0 = $("#set-pin-sheet"); if (ss0) ss0.classList.add("hidden"); const pl0 = $("#settings-pinlock"); if (pl0) pl0.checked = true; return; }
      Store.pinEnabled = false;
      Store.pinHash = "";
      Store.pinSalt = "";
      updateChangePinBtnVisibility();
      const pl = $("#settings-pinlock"); if (pl) pl.checked = false;
      const ss = $("#set-pin-sheet"); if (ss) ss.classList.add("hidden");
      toast(T("toast.pinOff"));
      return;
    }
    if (pinSheetMode === "verify-old") {
      const h = await pbkdf2Hex(v, Store.pinSalt, PIN_ITERATIONS);
      if (h !== Store.pinHash) { toast(T("toast.pinWrong")); return; }
      pinOldValue = v;
      // Старый PIN подтверждён — переходим ко ВТОРОЙ фазе: ввод НОВОГО
      // PIN. Раньше этой фазы не было вообще: экран просто закрывался,
      // и сменить PIN через интерфейс было физически невозможно.
      pinSheetMode = "enter-new";
      const st = $("#set-pin-title"); if (st) st.textContent = T("pin.newTitle");
      inp.value = "";
      inp.focus();
      return;
    }
    if (pinSheetMode === "enter-new") {
      if (SecureStore.isOn()) { // данные зашифрованы старым PIN — перешифровываем новым ДО смены хэша
        if (v.length < SecureStore.MIN_PIN) { toast(T("secure.pinShort", { n: SecureStore.MIN_PIN })); return; }
        // Файлы в IndexedDB зашифрованы ключом, производным от PIN: на время смены снимаем шифрование (старым ключом) и после смены запечатываем новым,
        // иначе после смены PIN все фото и голосовые стали бы нечитаемыми.
        await migrateFilesEncryption(false);
        try {
          if (!(await SecureStore.rekey(pinOldValue, v))) { await migrateFilesEncryption(true); toast(T("toast.pinWrong")); return; }
          await migrateFilesEncryption(true);
          await backupToIDB();
        } catch (e) { try { await migrateFilesEncryption(true); } catch (x) {} etherLog("error", "[secure] rekey", String(e)); toast(T("secure.failed")); return; }
      }
      pinOldValue = "";
      Store.pinSalt = randomSaltHex(16);
      Store.pinHash = await pbkdf2Hex(v, Store.pinSalt, PIN_ITERATIONS);
      const ss = $("#set-pin-sheet"); if (ss) ss.classList.add("hidden");
      toast(T("toast.pinChanged"));
      return;
    }
  };
  if (pinSave) pinSave.addEventListener("click", async () => {
    if (pinSaveBusy) return;
    pinSaveBusy = true;
    try { await pinSaveRun(); } finally { pinSaveBusy = false; }
  });
  const slider = $("#glass-slider");
  if (slider) slider.addEventListener("input", (e) => { const t = parseFloat(e.target.value); const v = transparencyToAlpha(t); Store.glassAlpha = v; applyGlassAlpha(v); });
  $$(".theme-seg button").forEach((btn) => {
    btn.addEventListener("click", () => {
      Store.theme = btn.dataset.theme;
      applyTheme(btn.dataset.theme);
      $$(".theme-seg button").forEach((b) => b.classList.toggle("active", b === btn));
    });
  });
  // Размер текста (Dynamic Type): сегменты Системный / Мелкий / Обычный / Крупный / Очень крупный (js/textscale.js).
  if (typeof TextScale !== "undefined") {
    const syncTs = () => $$("#text-scale-seg button").forEach((b) => { const on = b.dataset.textScale === TextScale.get(); b.classList.toggle("active", on); b.setAttribute("aria-checked", String(on)); });
    $$("#text-scale-seg button").forEach((b) => b.addEventListener("click", () => { TextScale.set(b.dataset.textScale); syncTs(); }));
    syncTs();
  }
  const readableToggle = $("#settings-readable-mode");
  if (readableToggle) { readableToggle.checked = Store.readableMode; readableToggle.addEventListener("change", () => { Store.readableMode = readableToggle.checked; applyChatAppearancePrefs(); }); }
  const calmModeToggle = $("#settings-calm-mode");
  if (calmModeToggle) { calmModeToggle.checked = Store.calmMode; calmModeToggle.addEventListener("change", () => { Store.calmMode = calmModeToggle.checked; applyCalmMode(); }); }
  const bubbleSizeSel = $("#settings-bubble-size");
  if (bubbleSizeSel) { bubbleSizeSel.value = Store.bubbleSize; bubbleSizeSel.addEventListener("change", () => { Store.bubbleSize = bubbleSizeSel.value; applyChatAppearancePrefs(); }); }
  const fontSizeSel = $("#settings-font-size");
  if (fontSizeSel) { fontSizeSel.value = Store.fontSize; fontSizeSel.addEventListener("change", () => { Store.fontSize = fontSizeSel.value; applyChatAppearancePrefs(); }); }
  const wallpaperSel = $("#settings-wallpaper");
  const wpColors = $("#settings-wallpaper-colors"), wpC1 = $("#settings-wp-color1"), wpC2 = $("#settings-wp-color2");
  const syncWpColors = () => { if (wpColors) wpColors.classList.toggle("hidden", Store.chatWallpaper !== "custom"); };
  if (wpC1) { wpC1.value = Store.wallpaperColor1; wpC1.addEventListener("input", () => { Store.wallpaperColor1 = wpC1.value; applyChatAppearancePrefs(); }); }
  if (wpC2) { wpC2.value = Store.wallpaperColor2; wpC2.addEventListener("input", () => { Store.wallpaperColor2 = wpC2.value; applyChatAppearancePrefs(); }); }
  if (wallpaperSel) { wallpaperSel.value = Store.chatWallpaper; syncWpColors(); wallpaperSel.addEventListener("change", () => { Store.chatWallpaper = wallpaperSel.value; syncWpColors(); applyChatAppearancePrefs(); }); }
}

// =====================================================================
// Глобальный поиск (раздел 1/11/13 роадмапа) — единая точка поиска по
// чатам, тексту сообщений, контактам, истории звонков и настройкам.
// Открывается кнопкой #global-search-btn в nav-bar (видна на всех
// экранах-списках) или шорткатом Cmd/Ctrl+K на десктопе. Намеренно НЕ
// реализован как pull-down-to-search на мобильном — список чатов уже
// занят своим pull-to-refresh (см. V.37.0.0), конкурирующий жест на том
// же экране добавил бы путаницу; кнопка в шапке работает одинаково
// предсказуемо на обеих платформах.
// =====================================================================
function openGlobalSearch(prefill) {
  const sheet = $("#global-search-sheet");
  if (!sheet) return;
  sheet.classList.remove("hidden");
  const input = $("#global-search-input");
  if (input) {
    const q = typeof prefill === "string" ? prefill : "";
    input.value = q;
    renderGlobalSearchResults(q);
    setTimeout(() => input.focus(), 50);
  }
}
function closeGlobalSearch() {
  const sheet = $("#global-search-sheet");
  if (sheet) sheet.classList.add("hidden");
}
// Переход в конкретную категорию настроек (используется и кликом по
// результату поиска, и может переиспользоваться где угодно ещё, где
// нужно программно открыть Settings на нужном разделе). Сбрасывает
// активный чат/карточку контакта и любой незакрытый #settings-search,
// чтобы категория точно стала видимой (см. updateSettingsCategoryView).
function navigateToSettingsCategory(catId) {
  resetChatTransientState(null);
  state.chatId = null;
  state.contactCardId = null;
  state.tab = "settings";
  state.settingsCategory = catId || null;
  const ss = $("#settings-search");
  if (ss && ss.value) {
    ss.value = "";
    $$("#screen-settings .settings-row").forEach((r) => r.classList.remove("search-hidden"));
    $$("#screen-settings .settings-group").forEach((g) => g.classList.remove("search-hidden"));
  }
  renderTab();
  updateSettingsCategoryView();
}
function renderGlobalSearchResults(rawQuery) {
  const resultsEl = $("#global-search-results");
  const emptyEl = $("#global-search-empty");
  if (!resultsEl) return;
  const q = String(rawQuery || "").trim();
  const qLower = q.toLowerCase();
  if (!qLower) { resultsEl.innerHTML = ""; if (emptyEl) emptyEl.classList.add("hidden"); return; }
  const allContacts = Array.from(state.contacts.values());
  const chatMatches = allContacts
    .filter((c) => c.messages && c.messages.length > 0 && (c.name || "").toLowerCase().includes(qLower))
    .slice(0, 6);
  // По одному (самому недавнему) совпадению на чат — иначе один активно
  // переписывающийся контакт с частым словом забил бы всю секцию.
  const messageMatches = [];
  for (const c of allContacts) {
    if (!c.messages || !c.messages.length) continue;
    for (let i = c.messages.length - 1; i >= 0; i--) {
      const text = c.messages[i].text || "";
      if (text.toLowerCase().includes(qLower)) { messageMatches.push({ contact: c, text }); break; }
    }
    if (messageMatches.length >= 6) break;
  }
  const contactMatches = allContacts
    .filter((c) => (!c.messages || !c.messages.length) && (c.name || "").toLowerCase().includes(qLower))
    .slice(0, 6);
  const callMatches = [];
  const seenCallContacts = new Set();
  for (const r of state.callLog.slice().sort((a, b) => b.startedAt - a.startedAt)) {
    if (seenCallContacts.has(r.contactId)) continue;
    const c = state.contacts.get(r.contactId);
    const name = (c && c.name) || "";
    if (name && name.toLowerCase().includes(qLower)) {
      callMatches.push({ contactId: r.contactId, name });
      seenCallContacts.add(r.contactId);
    }
    if (callMatches.length >= 6) break;
  }
  const settingsCategoryMatches = SETTINGS_CATEGORIES
    .filter((cat) => T(cat.labelKey).toLowerCase().includes(qLower))
    .map((cat) => ({ type: "category", id: cat.id, label: T(cat.labelKey) }));
  const settingsRowMatches = $$("#screen-settings .settings-row")
    .map((row) => ({ row, text: (row.textContent || "").trim() }))
    .filter((r) => r.text && r.text.toLowerCase().includes(qLower))
    .slice(0, 5)
    .map((r) => {
      const group = r.row.closest(".settings-group");
      return { type: "row", id: group && group.dataset.settingsCategory, label: truncate(r.text, 60) };
    });
  const settingsMatches = settingsCategoryMatches.concat(settingsRowMatches).slice(0, 6);

  const sections = [
    { key: "chats", titleKey: "search.global.sectionChats", rows: chatMatches.map((c) => globalSearchRowHtml("chat", c.id, avatarCircleHtml(c, "avatar-sm"), highlightRaw(escapeHtml(c.name || ""), q), "")) },
    { key: "messages", titleKey: "search.global.sectionMessages", rows: messageMatches.map((m) => globalSearchRowHtml("message", m.contact.id, avatarCircleHtml(m.contact, "avatar-sm"), escapeHtml(m.contact.name || ""), highlightRaw(escapeHtml(truncate(m.text, 60)), q))) },
    { key: "contacts", titleKey: "search.global.sectionContacts", rows: contactMatches.map((c) => globalSearchRowHtml("contact", c.id, avatarCircleHtml(c, "avatar-sm"), highlightRaw(escapeHtml(c.name || ""), q), "")) },
    { key: "calls", titleKey: "search.global.sectionCalls", rows: callMatches.map((r) => globalSearchRowHtml("call", r.contactId, avatarCircleHtml(state.contacts.get(r.contactId), "avatar-sm"), highlightRaw(escapeHtml(r.name), q), "")) },
    { key: "settings", titleKey: "search.global.sectionSettings", rows: settingsMatches.map((m) => globalSearchRowHtml(m.type === "category" ? "settings-category" : "settings-row", m.id, "", highlightRaw(escapeHtml(m.label), q), "")) },
  ].filter((s) => s.rows.length > 0);

  if (!sections.length) {
    resultsEl.innerHTML = "";
    if (emptyEl) emptyEl.classList.remove("hidden");
    return;
  }
  if (emptyEl) emptyEl.classList.add("hidden");
  resultsEl.innerHTML = sections.map((s) => `
    <div class="global-search-section">
      <div class="global-search-section-title">${escapeHtml(T(s.titleKey))}</div>
      <div class="forward-list">${s.rows.join("")}</div>
    </div>
  `).join("");
}
function globalSearchRowHtml(kind, id, avatarHtml, title, subtitle) {
  return `
    <button type="button" class="forward-row global-search-row" data-kind="${kind}" data-id="${escapeHtml(id || "")}">
      ${avatarHtml || ""}
      <span class="global-search-row-text">
        <span class="global-search-row-title">${title}</span>
        ${subtitle ? `<span class="global-search-row-subtitle muted">${subtitle}</span>` : ""}
      </span>
    </button>
  `;
}
// Один поиск вместо двух: на вкладках с собственным полем (Общение, Контакты, Настройки) лупа в шапке просто ведёт к этому полю,
// а когда в поле есть текст, под ним появляется «Искать везде» — переход в общий поиск (чаты, сообщения, контакты, настройки) с тем же запросом.
const INLINE_SEARCH_FIELDS = { chats: "#global-search", connect: "#contacts-search", settings: "#settings-search", debug: "#debug-search" };
// Поиск живёт в одном месте — лупа в шапке. По нажатию над списком выезжает поле поиска ТЕКУЩЕЙ вкладки (чаты / контакты / настройки);
// под ним — «Искать везде» (общий поиск по чатам, сообщениям, контактам и настройкам с тем же запросом). Пока поиск закрыт, места он не занимает.
function setInlineSearchOpen(open) {
  const root = document.documentElement;
  root.classList.toggle("inline-search-open", !!open);
  if (open) root.setAttribute("data-search-tab", state.tab);
  if (!open) {
    for (const sel of Object.values(INLINE_SEARCH_FIELDS)) {
      const el = $(sel);
      if (el && el.value) { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); }
    }
  }
}
function focusInlineSearchOrGlobal() {
  const sel = INLINE_SEARCH_FIELDS[state.tab];
  const el = sel && !state.chatId && !state.contactCardId ? $(sel) : null;
  if (!el) { openGlobalSearch(); return; }
  const isOpen = document.documentElement.classList.contains("inline-search-open") && document.documentElement.getAttribute("data-search-tab") === state.tab;
  if (isOpen) { setInlineSearchOpen(false); return; }
  setInlineSearchOpen(true);
  setTimeout(() => { try { el.focus(); } catch (e) {} }, 120);
}
// Все три поля (чаты, контакты, настройки) живут в одной «панели поиска» сразу под шапкой — на любой вкладке на одном и том же месте
function wireSearchBridge() {
  let dock = $("#search-dock");
  if (!dock) {
    dock = document.createElement("div"); dock.id = "search-dock";
    const nav = $("#nav-bar"); if (nav) nav.insertAdjacentElement("afterend", dock);
  }
  for (const [tab, sel] of Object.entries(INLINE_SEARCH_FIELDS)) {
    const input = $(sel); if (!input || input.dataset.bridge) continue;
    input.dataset.bridge = "1";
    let host = input.closest(".search-wrap");
    if (!host) { host = document.createElement("div"); host.className = "search-wrap"; input.parentNode.insertBefore(host, input); host.appendChild(input); input.style.marginBottom = ""; }
    host.classList.add("search-collapsible"); host.dataset.searchTab = tab;
    const link = document.createElement("button");
    link.type = "button"; link.className = "search-everywhere"; link.dataset.searchTab = tab;
    link.setAttribute("data-i18n", "search.everywhere"); link.textContent = T("search.everywhere");
    dock.appendChild(host); dock.appendChild(link);
    link.addEventListener("click", () => { const v = input.value.trim(); setInlineSearchOpen(false); openGlobalSearch(v); });
  }
}
// Вкладка «Отладка»: то же поле, что и на других вкладках (в общей панели под шапкой); фильтрует пункты экрана
function wireDebugSearch() {
  const input = $("#debug-search"); if (!input || input.dataset.filterWired) return;
  input.dataset.filterWired = "1";
  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    const scr = $("#screen-debug"); if (!scr) return;
    scr.querySelectorAll(".settings-group").forEach((g) => {
      const rows = Array.from(g.querySelectorAll(".settings-row, p.fine"));
      let any = false;
      rows.forEach((r) => {
        const hit = !q || (r.textContent || "").toLowerCase().includes(q) || (r.matches("p.fine") ? false : false);
        // пояснения (p.fine) показываем только без запроса; пункты — по совпадению текста (и вложенные строки считаются отдельно)
        const show = r.matches("p.fine") ? !q : (!q || hit);
        r.classList.toggle("search-hidden", !show);
        if (show && !r.matches("p.fine")) any = true;
      });
      g.classList.toggle("search-hidden", !!q && !any);
    });
  });
}
function wireGlobalSearch() {
  wireDebugSearch();
  const btn = $("#global-search-btn");
  if (btn) btn.addEventListener("click", focusInlineSearchOrGlobal);
  wireSearchBridge();
  const input = $("#global-search-input");
  let searchTimer = null;
  if (input) input.addEventListener("input", (e) => {
    const v = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => renderGlobalSearchResults(v), 150);
  });
  const resultsEl = $("#global-search-results");
  if (resultsEl) {
    resultsEl.addEventListener("click", (e) => {
      const row = e.target.closest(".global-search-row");
      if (!row) return;
      const kind = row.dataset.kind;
      const id = row.dataset.id;
      if (kind === "chat" || kind === "message" || kind === "call") {
        if (!id || !state.contacts.has(id)) { closeGlobalSearch(); return; }
        closeGlobalSearch();
        try { cancelVoiceRecordingIfLeavingChat(id); } catch (e) {}
        resetChatTransientState(id);
        state.chatId = id;
        state.contactCardId = null;
        renderTab();
      } else if (kind === "contact") {
        if (!id || !state.contacts.has(id)) { closeGlobalSearch(); return; }
        closeGlobalSearch();
        openContactCard(id);
      } else if (kind === "settings-category" || kind === "settings-row") {
        closeGlobalSearch();
        navigateToSettingsCategory(id);
      }
    });
  }
  // Cmd/Ctrl+K — стандартный десктопный шорткат для "перейти куда угодно"
  // (VS Code, Slack, Linear и т.п.), уже упомянут в разделах 1/11 роадмапа.
  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      openGlobalSearch();
    }
  });
  // Esc "на всех шторках" (раздел 11/13 роадмапа) теперь общий
  // document-level хендлер — см. wireEscCloseAnySheet() ниже, подключается
  // отдельно при старте, не только здесь.
}
// Esc закрывает самую верхнюю открытую .sheet, какая бы это ни была —
// во всей кодовой базе ~20 разных шторок, и ВСЕ они без исключения
// управляются одинаково: класс .hidden снимается при открытии и
// добавляется при закрытии (см. wireSheetBackdrops выше, data-close-sheet,
// свайп за .sheet-handle). Это значит, что закрытие — это всегда ровно
// "добавить .hidden", без побочных эффектов, специфичных для конкретной
// шторки (ни одна из них не хранит какое-то дополнительное состояние,
// которое нужно было бы сбрасывать при закрытии именно через Esc, а не
// через крестик/бэкдроп/свайп) — поэтому единый обработчик безопасен для
// всех них сразу, без точечной доработки каждой по отдельности.
// Если открыто несколько шторок одновременно (в норме не происходит, но
// на случай незамеченного состояния) — закрываем последнюю в DOM-порядке,
// т.к. шторки всегда дописываются в конец документа и визуально самая
// "верхняя" по z-index оказывается последней.
function wireEscCloseAnySheet() {
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const openSheets = $$(".sheet:not(.hidden)");
    if (openSheets.length === 0) return;
    openSheets[openSheets.length - 1].classList.add("hidden");
  });
}
// Раздел 11 — фокус-менеджмент шторок (был в "Сознательно отложено").
// Тот же аргумент об однородности, что выше у wireEscCloseAnySheet:
// все ~20 шторок открываются/закрываются ровно одним и тем же способом
// (снятие/добавление .sheet.hidden, без иных побочных эффектов) — значит
// один MutationObserver на все .sheet сразу безопасно даёт: (1) фокус
// внутрь шторки при открытии, если ничто более специфичное не
// позаботилось об этом само (многие шторки уже фокусируют конкретное
// поле — тот код просто выигрывает гонку, выполняясь позже в своём
// setTimeout, и наш общий автофокус для них невидим); (2) возврат фокуса
// на элемент-источник при закрытии — вместо того, чтобы он проваливался
// в <body>, как было раньше у всех шторок без исключения; (3) Tab-ловушку
// внутри самой верхней открытой шторки, вместо утечки фокуса под неё.
const __sheetReturnFocus = new WeakMap();
function focusableIn(container) {
  if (!container) return [];
  return Array.from(container.querySelectorAll('button, [href], input, select, textarea, [tabindex]'))
    .filter((el) => !el.disabled && el.tabIndex !== -1 && el.offsetParent !== null && !el.classList.contains("sheet-backdrop"));
}
function wireSheetFocusManagement() {
  const sheets = $$(".sheet");
  if (sheets.length === 0) return;
  const observer = new MutationObserver((mutations) => {
    for (const mut of mutations) {
      const el = mut.target;
      if (!(el instanceof Element) || !el.classList.contains("sheet")) continue;
      if (!el.classList.contains("hidden")) {
        if (!__sheetReturnFocus.has(el)) __sheetReturnFocus.set(el, document.activeElement);
        const panel = el.querySelector(".sheet-panel") || el;
        const already = panel.contains(document.activeElement) && document.activeElement !== document.body;
        if (!already) {
          const focusables = focusableIn(panel);
          if (focusables.length > 0) setTimeout(() => { if (!el.classList.contains("hidden") && document.activeElement === document.body) focusables[0].focus(); }, 0);
        }
      } else {
        const src = __sheetReturnFocus.get(el);
        __sheetReturnFocus.delete(el);
        if (src && document.body.contains(src) && typeof src.focus === "function" && document.activeElement === document.body) src.focus();
      }
    }
  });
  sheets.forEach((el) => observer.observe(el, { attributes: true, attributeFilter: ["class"] }));
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const openSheets = $$(".sheet:not(.hidden)");
    if (openSheets.length === 0) return;
    const top = openSheets[openSheets.length - 1];
    const panel = top.querySelector(".sheet-panel") || top;
    const focusables = focusableIn(panel);
    if (focusables.length === 0) return;
    const first = focusables[0], last = focusables[focusables.length - 1];
    if (!panel.contains(document.activeElement)) { e.preventDefault(); first.focus(); return; }
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}
// Cmd/Ctrl+N ("новый чат"/"добавить контакт") — ИССЛЕДОВАНО (раздел 11/13),
// НЕ РЕАЛИЗУЕМО: Ctrl/Cmd+N относится к небольшому списку акселераторов,
// захардкоженных самим браузером как "новое окно" (вместе с Ctrl+T/
// Ctrl+W/Ctrl+Tab и т.п.) — событие keydown для него в принципе не
// доходит до JS страницы ни в Chrome, ни в Firefox, ни в Safari, ни во
// вкладке браузера, ни в установленном PWA-окне. Это не ограничение
// текущей реализации — перехватить такой шорткат из веб-страницы
// невозможно никаким кодом. Остаётся в бэктлоге как "признано
// неприменимым", аналогично тому, как Cmd+Enter был признан
// неприменимым в V.41.0.0 (композер однострочный), только по другой
// причине.

// =====================================================================
// Отладка
// =====================================================================
function applyDebugTabVisibility() {
  const hidden = Store.debugHidden;
  const tab = document.getElementById("tab-debug");
  if (tab) tab.classList.toggle("hidden", hidden);
  const toggle = document.getElementById("debug-hide-toggle");
  if (toggle) toggle.checked = hidden;
  if (hidden && state.tab === "debug") { state.tab = "chats"; renderTab(); }
}
function wireNavTitleTaps() {
  const el = document.getElementById("nav-title");
  if (!el) return;
  el.addEventListener("click", () => {
    const now = Date.now();
    __navTitleTaps = __navTitleTaps.filter((t) => now - t < 2000);
    __navTitleTaps.push(now);
    // Фидбек на подходе к разблокировке — иначе пользователь не понимает,
    // что тапы вообще считаются, пока не откроется вкладка на 5-м.
    if (__navTitleTaps.length === 3 || __navTitleTaps.length === 4) haptic("light");
    if (__navTitleTaps.length >= 5) {
      __navTitleTaps = [];
      haptic("medium");
      Store.debugHidden = false;
      applyDebugTabVisibility();
    }
  });
}
// P3.47 — "паника": 5 тапов по логотипу в "О приложении" → подтверждение
// → необратимая мгновенная очистка всех данных устройства и перезапуск
// с чистого листа. Нарочно скрыто за тапами (а не отдельной видимой
// кнопкой в UI) и НЕ требует предварительной разблокировки debug-вкладки
// (в отличие от debug-hard-reset-btn, который делает то же самое, но
// спрятан на 2 экрана глубже) — весь смысл паника-кнопки в том, чтобы
// быть доступной за секунды в стрессовой ситуации, а не быть удобной
// для случайного нажатия.
// Общая необратимая очистка — раньше была только внутри wirePanicButton,
// теперь переиспользуется и встряхиванием (killer-features-backlog 1.7).
function performPanicWipe() { return wipeEverythingAndReload(); }
function wirePanicButton() {
  const el = document.getElementById("about-app-logo");
  if (!el) return;
  el.addEventListener("click", async () => {
    const now = Date.now();
    __panicTaps = __panicTaps.filter((t) => now - t < 2000);
    __panicTaps.push(now);
    if (__panicTaps.length >= 5) {
      __panicTaps = [];
      if (!await confirmSheet(T("toast.confirmPanic"), { destructive: true })) return;
      performPanicWipe();
    }
  });
}
// killer-features-backlog 1.7 — Panic Clean (встряхнуть телефон → очистка).
// Честная оговорка (см. Store.panicShakeEnabled выше): DeviceMotion на iOS
// 13+ требует permission-промпт по явному жесту пользователя (запрашиваем
// при включении тумблера) и в принципе ненадёжен в фоне — это ПОЭТОМУ не
// "silent background trigger", а быстрый, но ОТМЕНЯЕМЫЙ (4 секунды) wipe,
// чтобы случайное резкое движение (выпал из рук, активная игра) не стёрло
// данные без шанса передумать.
const SHAKE_THRESHOLD = 35; // м/с² суммарно по 3 осям — эмпирический порог резкого рывка
const SHAKE_DEBOUNCE_MS = 3000;
const SHAKE_WIPE_DELAY_MS = 4000;
let __shakeLastTrigger = 0;
let __shakeWipeTimer = null;
function handleShakeMotion(e) {
  const a = e.accelerationIncludingGravity || e.acceleration;
  if (!a) return;
  const mag = Math.abs(a.x || 0) + Math.abs(a.y || 0) + Math.abs(a.z || 0);
  if (mag < SHAKE_THRESHOLD) return;
  const now = Date.now();
  if (now - __shakeLastTrigger < SHAKE_DEBOUNCE_MS) return;
  __shakeLastTrigger = now;
  triggerPanicShakeWipe();
}
function triggerPanicShakeWipe() {
  if (__shakeWipeTimer) return; // уже отсчитывается — повторный рывок не перезапускает таймер
  const banner = $("#panic-shake-banner"); if (banner) banner.classList.remove("hidden");
  __shakeWipeTimer = setTimeout(() => {
    __shakeWipeTimer = null;
    if (banner) banner.classList.add("hidden");
    performPanicWipe();
  }, SHAKE_WIPE_DELAY_MS);
}
function cancelPanicShakeWipe() {
  if (__shakeWipeTimer) { clearTimeout(__shakeWipeTimer); __shakeWipeTimer = null; }
  const banner = $("#panic-shake-banner"); if (banner) banner.classList.add("hidden");
}
async function requestMotionPermissionIfNeeded() {
  // DeviceMotionEvent.requestPermission существует только на iOS 13+ —
  // на Android и десктопе его просто нет, доступ не требует жеста.
  if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function") {
    try {
      const ok = (await DeviceMotionEvent.requestPermission()) === "granted";
      try { localStorage.setItem("ether.motionOk", ok ? "1" : "0"); } catch (e) {}
      if (ok) wireShakeUndoGuard();
      return ok;
    } catch (e) { return false; }
  }
  return true;
}
// iOS показывает системное окно «Отменить ввод?» при встряхивании, если в фокусе поле с набранным текстом (отключить его из веба
// нельзя), а в PWA оно ещё и ломает раскладку. Лучшее, что можно сделать: как только датчик движения (если доступ уже разрешён)
// видит резкую встряску, снимаем фокус с поля — тогда окно не появляется, а набранный текст остаётся в черновике.
let __shakeUndoGuardOn = false;
function wireShakeUndoGuard() {
  if (__shakeUndoGuardOn || typeof DeviceMotionEvent === "undefined") return;
  if (typeof DeviceMotionEvent.requestPermission === "function") {
    let ok = false; try { ok = localStorage.getItem("ether.motionOk") === "1"; } catch (e) {}
    if (!ok) return; // без разрешения датчик недоступен, ничего не делаем (спрашивать ради этого не будем)
  }
  __shakeUndoGuardOn = true;
  window.addEventListener("devicemotion", (e) => {
    const a = e.accelerationIncludingGravity || e.acceleration; if (!a) return;
    if (Math.abs(a.x || 0) + Math.abs(a.y || 0) + Math.abs(a.z || 0) < 32) return;
    const el = document.activeElement;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) { try { saveCurrentDraft(); } catch (er) {} el.blur(); }
  }, { passive: true });
}
function wirePanicShake() {
  if (typeof DeviceMotionEvent === "undefined") return;
  window.removeEventListener("devicemotion", handleShakeMotion); // идемпотентность — safeCall может дёрнуть дважды
  window.addEventListener("devicemotion", handleShakeMotion);
}
function unwirePanicShake() {
  window.removeEventListener("devicemotion", handleShakeMotion);
  cancelPanicShakeWipe();
}
function wirePanicShakeBanner() {
  const btn = $("#panic-shake-cancel-btn");
  if (btn) btn.addEventListener("click", cancelPanicShakeWipe);
}
const HELP_SECTIONS = [
  "start", "contacts", "messaging", "media", "disappearing", "groups", "calls", "privacy", "settingsHelp",
];
function renderHelp() {
  const el = $("#help-content"); if (!el) return;
  el.innerHTML = HELP_SECTIONS.map((key) => {
    const title = T("help." + key + ".title");
    const body = T("help." + key + ".body");
    return `<h3>${escapeHtml(title)}</h3><p>${escapeHtml(body).replace(/\n/g, "<br>")}</p>`;
  }).join("");
}
function wireDebugScreen() {
  const diag = $("#diagnostics-btn");
  if (diag) diag.addEventListener("click", () => { renderDiagnostics(); const el = $("#diagnostics-sheet"); if (el) el.classList.remove("hidden"); });
  const diagClose = $("#diagnostics-close");
  if (diagClose) diagClose.addEventListener("click", () => { const el = $("#diagnostics-sheet"); if (el) el.classList.add("hidden"); });
  const diagR = $("#diagnostics-refresh-btn");
  if (diagR) diagR.addEventListener("click", renderDiagnostics);
  const diagC = $("#diagnostics-copy-btn");
  if (diagC) diagC.addEventListener("click", () => copyText(buildDiagnosticsText(), T("toast.msgCopied")));

  const webrtcBtn = $("#webrtc-debug-btn");
  if (webrtcBtn) webrtcBtn.addEventListener("click", () => { renderWebRtcSheet(); const el = $("#webrtc-sheet"); if (el) el.classList.remove("hidden"); });
  const webrtcClose = $("#webrtc-close");
  if (webrtcClose) webrtcClose.addEventListener("click", () => { const el = $("#webrtc-sheet"); if (el) el.classList.add("hidden"); });
  const webrtcRefresh = $("#webrtc-refresh-btn");
  if (webrtcRefresh) webrtcRefresh.addEventListener("click", renderWebRtcSheet);
  const webrtcCopy = $("#webrtc-copy-btn");
  if (webrtcCopy) webrtcCopy.addEventListener("click", () => copyText(buildWebRtcText(), T("toast.msgCopied")));

  const logsBtn = $("#debug-logs-btn");
  if (logsBtn) logsBtn.addEventListener("click", () => { renderLogsSheet(); const el = $("#logs-sheet"); if (el) el.classList.remove("hidden"); });
  const logsClose = $("#logs-close");
  if (logsClose) logsClose.addEventListener("click", () => { const el = $("#logs-sheet"); if (el) el.classList.add("hidden"); });
  const logsCopy = $("#logs-copy-btn");
  if (logsCopy) logsCopy.addEventListener("click", () => copyText(buildLogsText(), T("toast.msgCopied")));
  const logsClear = $("#logs-clear-btn");
  if (logsClear) logsClear.addEventListener("click", () => { window.__etherDiag = []; renderLogsSheet(); });

  const blockedBtn = $("#settings-blocked-btn");
  if (blockedBtn) blockedBtn.addEventListener("click", () => { renderBlockedSheet(); const el = $("#blocked-sheet"); if (el) el.classList.remove("hidden"); });
  const blockedClose = $("#blocked-close");
  if (blockedClose) blockedClose.addEventListener("click", () => { const el = $("#blocked-sheet"); if (el) el.classList.add("hidden"); });
  const blockedList = $("#blocked-list");
  if (blockedList) blockedList.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-unblock-id]"); if (!btn) return;
    const c = state.contacts.get(btn.dataset.unblockId); if (!c) return;
    c.blocked = false; persistContacts(); toast(T("toast.unblocked")); renderBlockedSheet();
  });
  const storageBtn = $("#debug-storage-btn");
  if (storageBtn) storageBtn.addEventListener("click", async () => { try { await renderStorageSheet(); } catch (e) {} const el = $("#storage-sheet"); if (el) el.classList.remove("hidden"); });
  const storageClose = $("#storage-close");
  if (storageClose) storageClose.addEventListener("click", () => { const el = $("#storage-sheet"); if (el) el.classList.add("hidden"); });
  const clearOldMediaBtn = $("#storage-clear-old-media-btn");
  if (clearOldMediaBtn) clearOldMediaBtn.addEventListener("click", async () => {
    if (!await confirmSheet(T("storage.clearOldMedia") + "?", { destructive: true })) return;
    clearOldMedia(30);
  });
  const turnBtn = $("#turn-check-btn");
  if (turnBtn) turnBtn.addEventListener("click", async () => {
    const out = $("#turn-check-out"); if (!out || turnBtn.__busy) return;
    turnBtn.__busy = true; out.classList.remove("hidden"); out.textContent = T("debug.turnChecking");
    try {
      const rows = typeof window.etherTurnCheck === "function" ? await window.etherTurnCheck() : [];
      out.textContent = rows.length ? rows.map((r) => (r.open ? "✅ " : r.relay ? "⚠️ " : "❌ ") + r.url + (r.relayAddr ? " [" + r.relayAddr + "]" : "") + " — "
        + (r.open ? T("debug.turnOk", { ms: r.openMs }) : r.relay ? T("debug.turnAllocOnly") : T("debug.turnNoAlloc")) + (r.error ? " (" + r.error + ")" : "") + (r.diag ? "\n   " + r.diag : "")).join("\n")
        : T("debug.turnNone");
      rows.forEach((r) => etherLog(r.open ? "info" : "warn", "[turn-check]", r.url, r.open ? "relay OK " + r.openMs + "мс" : r.relay ? "allocation есть, данные не идут" + (r.diag ? " [" + r.diag + "]" : "") : "allocation не получен" + (r.diag ? " [" + r.diag + "]" : "")));
    } catch (e) { out.textContent = String(e && e.message || e); }
    turnBtn.__busy = false;
  });
  const exportDiag = $("#export-diagnostics-btn");
  if (exportDiag) exportDiag.addEventListener("click", exportFullDiagnostics);

  const expBackup = $("#export-backup-btn");
  if (expBackup) expBackup.addEventListener("click", exportBackup);
  const impBackup = $("#import-backup-btn");
  if (impBackup) impBackup.addEventListener("click", () => { const el = $("#import-backup-input"); if (el) el.click(); });
  wireImportBackupInput();

  const reset = $("#reset-all-btn");
  if (reset) reset.addEventListener("click", async () => {
    if (!await confirmSheet(T("toast.confirmDeleteAllChats"), { destructive: true })) return;
    for (const id of Array.from(state.contacts.keys())) mesh.remove(id);
    for (const t of autoConnectTimers.values()) clearTimeout(t);
    autoConnectTimers.clear();
    onlineSet.clear(); outbox.clear(); groupDeliveryMap.clear(); pendingNoKey.clear(); seenDeliverIds.clear(); seenGroupInviteIds.clear(); recentlyDeletedIds.clear();
    // медиа, ratchet-сессии и удержанные конверты тоже относятся к «всем чатам»
    try { for (const c of state.contacts.values()) if (c.messages) cleanupExpiredFileBlobs(c.messages); } catch (e) {}
    try { Ratchet.resetAll(); } catch (e) {}
    try { heldDeliveries = []; persistHeld(); envelopeCache.clear(); } catch (e) {}
    state.contacts.clear(); state.callLog = []; state.currentCallRecord = null;
    state.lastSeen = {}; state.drafts = {}; state.scheduledMessages = []; state.folders = [];
    // Если в момент сброса был в полёте дебаунс-таймер persistContacts()
    // (см. persistContactsNow выше) — он бы минут через 0.2с воскресил
    // только что обнулённый список из устаревшего __contactsPersistPending.
    if (__contactsPersistTimer) { clearTimeout(__contactsPersistTimer); __contactsPersistTimer = null; }
    __contactsPersistPending = null;
    Store.contactsJson = "[]"; Store.outboxJson = "[]"; Store.groupDeliveryMapJson = "[]"; Store.pendingNoKeyJson = "{}";
    Store.callLogJson = "[]"; Store.lastSeenJson = "{}"; Store.draftsJson = "{}"; Store.recentlyDeletedJson = "{}"; Store.scheduledMessagesJson = "[]";
    Store.chatFoldersJson = "[]"; renderChatFolderChips();
    resetConnectScreen(); renderTab();
  });
  const hard = $("#debug-hard-reset-btn");
  if (hard) hard.addEventListener("click", async () => {
    if (!await confirmSheet(T("toast.confirmHardReset"), { destructive: true })) return;
    performFullAccountWipe();
  });
  // «Удалить аккаунт» в обычных настройках — та же необратимая операция,
  // что и debug-hard-reset-btn (раньше была доступна только за 5 тапов
  // в скрытом Debug-экране), но с явным подтверждением, которое называет
  // вещи своими именами: нет серверной копии, отменить нельзя.
  const delAcc = $("#settings-delete-account-btn");
  if (delAcc) delAcc.addEventListener("click", async () => {
    if (!await confirmSheet(T("toast.confirmDeleteAccount"), { destructive: true })) return;
    performFullAccountWipe();
  });
  const hideToggle = $("#debug-hide-toggle");
  if (hideToggle) hideToggle.addEventListener("change", (e) => {
    Store.debugHidden = e.target.checked;
    applyDebugTabVisibility();
  });
}
function renderLogsSheet() { const el = $("#logs-content"); if (el) el.textContent = buildLogsText(); }
function buildLogsText() {
  const log = window.__etherDiag || [];
  const lines = [];
  for (const entry of log.slice(-300)) {
    const d = new Date(entry.ts);
    const stamp = `${d.toLocaleTimeString(I18N.current)}.${String(d.getMilliseconds()).padStart(3, "0")}`;
    lines.push(`[${stamp}] [${entry.level}] ${entry.line}`);
  }
  return lines.join("\n");
}
// P2 — отдельный экран "Заблокированные": раньше разблокировать можно
// было только найдя контакт и открыв его карточку, что неудобно, если
// хочешь просто обзору список кого заблокировал.
function renderBlockedSheet() {
  const list = $("#blocked-list");
  const empty = $("#blocked-empty");
  if (!list) return;
  const blocked = Array.from(state.contacts.values()).filter((c) => c.blocked && !isGroup(c));
  list.innerHTML = blocked.map((c) => `
    <div class="forward-row">
      ${avatarCircleHtml(c, "avatar-sm")}
      <span class="forward-name">${escapeHtml(c.name || T("sys.someone"))}</span>
      <button type="button" class="btn-secondary small" data-unblock-id="${escapeHtml(c.id)}">${escapeHtml(T("chat.contact.unblock"))}</button>
    </div>`).join("");
  if (empty) empty.classList.toggle("hidden", blocked.length > 0);
}
async function renderStorageSheet() {
  const el = $("#storage-summary"); if (!el) return;
  const items = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith("ether.")) continue;
    const v = localStorage.getItem(k) || "";
    items.push({ key: k, size: v.length });
  }
  items.sort((a, b) => b.size - a.size);
  const totalBytes = items.reduce((s, x) => s + x.size, 0);
  // IndexedDB (файлы/медиа) + Cache Storage (сервис-воркер) — то, что
  // реально занимает место на диске, в отличие от localStorage (там
  // только метаданные/ссылки). navigator.storage.estimate() не точен
  // по байту, но даёт честный порядок величины.
  let idbSize = "—";
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      if (est && typeof est.usage === "number") {
        idbSize = `${(est.usage / 1024 / 1024).toFixed(1)} MB` + (est.quota ? ` / ${(est.quota / 1024 / 1024).toFixed(0)} MB` : "");
      }
    }
  } catch (e) {}
  const bd = await computeStorageBreakdown(items);
  const rows = bd.rows.map((r) => `<div class="storage-row"><span>${escapeHtml(T("storage.cat." + (r.key === "other" ? "misc" : r.key)))}</span><b>${escapeHtml(formatFileSize(r.bytes))}</b><i style="width:${bd.max ? Math.max(2, Math.round(r.bytes / bd.max * 100)) : 0}%"></i></div>`).join("");
  el.innerHTML = `<div class="storage-breakdown">${rows}</div><div class="fine muted">${escapeHtml(T("storage.total", { used: idbSize }))}</div><div>localStorage: ${(totalBytes / 1024).toFixed(1)} KB, ${items.length} keys</div>` + buildEnvText();
}
// Разбивка занятого места по категориям: переписка (localStorage), медиа по типам (по метаданным сообщений), кэш приложения (Cache Storage), прочее
async function computeStorageBreakdown(lsItems) {
  const bytes = { messages: 0, photos: 0, videos: 0, voice: 0, files: 0, cache: 0, other: 0 };
  for (const it of lsItems) { if (it.key === "ether.contacts") bytes.messages += it.size; else bytes.other += it.size; }
  for (const c of state.contacts.values()) for (const m of c.messages) {
    const f = m.file; if (!f || f.pending || f.failed || !(f.size > 0)) continue;
    if (f.kind === "image") bytes.photos += f.size; else if (f.kind === "video") bytes.videos += f.size; else if (f.kind === "audio") bytes.voice += f.size; else bytes.files += f.size;
  }
  try {
    if (typeof caches !== "undefined") {
      for (const name of await caches.keys()) {
        const cache = await caches.open(name), reqs = (await cache.keys()).slice(0, 300);
        for (const r of reqs) { const resp = await cache.match(r); if (resp) { const len = parseInt(resp.headers.get("content-length") || "0", 10); bytes.cache += len || (await resp.clone().blob()).size; } }
      }
    }
  } catch (e) {}
  const rows = Object.entries(bytes).map(([key, b]) => ({ key, bytes: b })).filter((r) => r.bytes > 0).sort((a, b) => b.bytes - a.bytes);
  return { rows, max: rows.length ? rows[0].bytes : 0 };
}
// P1.19 — удаляет блобы (фото/видео/голосовые/документы) старше N дней
// из IndexedDB, не трогая сами сообщения (текст и метаданные остаются,
// просто сам файл станет "недоступен" — как при истёкшем TTL). Текст
// переписки — не то, что обычно раздувает хранилище, медиа — то, что
// нужно.
async function clearOldMedia(days) {
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  let cleared = 0;
  for (const c of state.contacts.values()) {
    const old = c.messages.filter((m) => m.file && m.ts < cutoff);
    for (const m of old) {
      try { await IDB.del("file:" + m.id); cleared++; } catch (e) {}
      try { // кэши держали бы удалённый файл (blob URL / играющее аудио) до перезапуска
        const url = typeof fileBlobUrlCache !== "undefined" ? fileBlobUrlCache.get(m.id) : null;
        if (url) { URL.revokeObjectURL(url); fileBlobUrlCache.delete(m.id); }
        const vc = typeof voiceAudioCache !== "undefined" ? voiceAudioCache.get(m.id) : null;
        if (vc) { try { vc.audio.pause(); } catch (e) {} voiceAudioCache.delete(m.id); }
      } catch (e) {}
    }
  }
  toast(T("toast.oldMediaCleared"));
  if (state.chatId) { try { renderChatThreadInner(); } catch (e) {} }
  try { await renderStorageSheet(); } catch (e) {}
  return cleared;
}
function buildEnvText() {
  return `<hr><div>UA: ${escapeHtml(navigator.userAgent)}</div>`;
}
function buildStorageText() {
  const items = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith("ether.")) continue;
    const v = localStorage.getItem(k) || "";
    items.push({ key: k, size: v.length });
  }
  items.sort((a, b) => b.size - a.size);
  const totalBytes = items.reduce((s, x) => s + x.size, 0);
  const lines = [`localStorage: ${(totalBytes / 1024).toFixed(1)} KB, ${items.length} keys`];
  for (const it of items) lines.push(`  ${it.key}: ${it.size} B`);
  lines.push("UA: " + navigator.userAgent);
  return lines.join("\n");
}
// Метрики окна/вьюпорта для разбора проблем вёрстки на iPhone (полоса под футером, safe area):
// сравнение innerHeight, screen.height, visualViewport, 100vh/100dvh/100svh/100lvh и инсетов.
function collectViewportMetrics() {
  const out = [];
  const r1 = (n) => (typeof n === "number" && isFinite(n) ? String(Math.round(n * 10) / 10) : "—");
  try {
    const vv = window.visualViewport;
    out.push("Standalone: " + isStandalone() + " (navigator.standalone=" + String(navigator.standalone) + ")");
    out.push("inner: " + r1(window.innerWidth) + "x" + r1(window.innerHeight) + ", outer: " + r1(window.outerWidth) + "x" + r1(window.outerHeight));
    out.push("screen: " + r1(screen.width) + "x" + r1(screen.height) + ", avail: " + r1(screen.availWidth) + "x" + r1(screen.availHeight) + ", dpr: " + r1(window.devicePixelRatio));
    out.push("visualViewport: " + (vv ? r1(vv.width) + "x" + r1(vv.height) + " off(" + r1(vv.offsetLeft) + "," + r1(vv.offsetTop) + ") scale " + r1(vv.scale) : "—"));
    out.push("html client: " + r1(document.documentElement.clientWidth) + "x" + r1(document.documentElement.clientHeight) + ", scrollY: " + r1(window.scrollY));
    const probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText = "position:fixed;left:0;top:0;width:0;visibility:hidden;pointer-events:none;";
    document.body.appendChild(probe);
    const measure = (css) => { probe.style.cssText = "position:fixed;left:0;top:0;width:0;visibility:hidden;pointer-events:none;" + css; return probe.getBoundingClientRect().height; };
    out.push("100vh: " + r1(measure("height:100vh")) + ", 100dvh: " + r1(measure("height:100dvh")) + ", 100svh: " + r1(measure("height:100svh")) + ", 100lvh: " + r1(measure("height:100lvh")) + ", 100%: " + r1(measure("height:100%")));
    out.push("fixed inset:0 → " + r1(measure("top:0;bottom:0;height:auto;position:fixed")) + ", fill-available: " + r1(measure("height:-webkit-fill-available")));
    out.push("safe-area top/bottom/left/right: " + ["top", "bottom", "left", "right"].map((side) => r1(measure("height:env(safe-area-inset-" + side + ", 0px)"))).join(" / "));
    probe.remove();
    const rect = (sel) => { const el = document.querySelector(sel); if (!el) return "—"; const r = el.getBoundingClientRect(); return "top " + r1(r.top) + " bottom " + r1(r.bottom) + " h " + r1(r.height); };
    out.push("body: " + rect("body"));
    out.push("#app-shell: " + rect("#app-shell"));
    out.push("#tab-bar: " + rect("#tab-bar"));
    const vp = document.querySelector('meta[name="viewport"]');
    out.push("viewport meta: " + (vp ? vp.content : "—"));
  } catch (e) { out.push("metrics error: " + String(e)); }
  return out;
}
function buildDiagnosticsText() {
  const lines = [];
  lines.push("The Messenger — diagnostics, " + APP_VERSION);
  lines.push("Time: " + new Date().toLocaleString(I18N.current));
  lines.push("Lang: " + I18N.current + " / sys " + I18N.systemLang());
  lines.push("My id: " + (Store.myId ? Store.myId.slice(0, 16) + "…" : "—"));
  try {
    const ki = JSON.parse(localStorage.getItem("ether.keyInfo") || "null");
    const seed = typeof fxSeed === "function" ? fxSeed("sigil|" + fxMyKeyString())().toString(16).padStart(8, "0") : "—";
    lines.push("Keys: rune-seed " + seed + (ki ? ", создана " + new Date(ki.at).toLocaleString(I18N.current) + ", создана раз: " + ki.count + (ki.existing ? " (поверх существующего профиля)" : "") : ", создана до V.62.0.4"));
  } catch (e) {}
  try {
    const rows = [];
    for (const c of state.contacts.values()) {
      if (c.isGroup || c.isSelf || !c.managed) continue;
      const l = mesh && mesh.get(c.id);
      rows.push("  " + String(c.id).slice(0, 10) + "… rc=" + (c.rc ? 1 : 0) + " ratchet: " + (typeof Ratchet !== "undefined" ? Ratchet.info(c.id) : "—") + " | key: " + (c.pendingKey ? "ждёт подтверждения" : isContactVerified(c) ? "проверен" : "TOFU") + " | канал: " + (l ? (l.authState || "—") : "нет линка"));
    }
    lines.push("Ratchet/trust (" + rows.length + "):"); for (const r of rows.slice(0, 40)) lines.push(r);
  } catch (e) {}
  lines.push("Signaling: " + effectiveSignalingUrl());
  lines.push("Status: " + (signaling ? (signaling.connected ? "on" : "off") : "—"));
  lines.push("Online: " + onlineSet.size);
  lines.push("outbox: " + outbox.size + ", pendingNoKey: " + pendingNoKey.size);
  lines.push("Call: " + (state.callId ? state.callId.slice(0, 10) + " phase=" + state.callPhase : "—"));
  lines.push("--- viewport ---");
  for (const l of collectViewportMetrics()) lines.push(l);
  return lines.join("\n");
}
function renderDiagnostics() {
  const log = $("#diagnostics-log"); if (log) log.textContent = buildDiagnosticsText();
}
function renderWebRtcSheet() { const el = $("#webrtc-content"); if (el) el.textContent = buildWebRtcText(); }
function buildWebRtcText() {
  const lines = [];
  if (!mesh || mesh.links.size === 0) { lines.push("(no peers)"); return lines.join("\n"); }
  for (const link of mesh.links.values()) {
    const d = link.getDiagnostics();
    lines.push("--- " + String(d.id).slice(0, 14) + "… ---");
    lines.push("role: " + d.role + ", status: " + d.status);
    lines.push("pc: " + d.pcState + ", ice: " + d.iceState + ", dc: " + d.dcState);
    if (d.lastPair) lines.push("pair: " + d.lastPair);
    lines.push("");
  }
  return lines.join("\n");
}

