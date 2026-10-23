"use strict";
// Часть 11 из 14 бывшего js/app.js: QR, шиты, перевод сообщений. Глобальная область общая; порядок <script> важен.

// =====================================================================
// QR-код для добавления контакта
// =====================================================================
// Вынесено из renderMyQrCode() в V.52.0.0 — та же отрисовка нужна и на
// слайде 4 онбординга (см. renderOnboardingReadySlide), не только в
// шторке "My QR code". По умолчанию кодирует свой собственный add-код
// (как и раньше); необязательный payload (V.55.0.0) позволяет рисовать
// QR с произвольной полезной нагрузкой — используется для invite-ссылки
// в группу (см. openGroupInviteSheet), которая кодирует не "свой" код.
function renderQrToCanvas(canvas, payload) {
  if (!canvas || typeof qrcode !== "function") return;
  if (!payload) payload = "ether://add?id=" + encodeURIComponent(Store.myId) + "&name=" + encodeURIComponent(Store.name || "");
  const qr = qrcode(0, "M"); // typeNumber 0 = автоподбор размера под данные
  qr.addData(payload);
  qr.make();
  const n = qr.getModuleCount();
  const size = canvas.width;
  const scale = size / n;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#000000";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (qr.isDark(y, x)) ctx.fillRect(Math.round(x * scale), Math.round(y * scale), Math.ceil(scale), Math.ceil(scale));
    }
  }
}
function renderMyQrCode() { renderQrToCanvas($("#my-qr-canvas")); }
function parseQrAddPayload(text) {
  try {
    if (!text || text.indexOf("ether://add?") !== 0) return null;
    const qs = new URLSearchParams(text.slice(text.indexOf("?")));
    const id = qs.get("id");
    if (!id) return null;
    return { id, name: qs.get("name") || "" };
  } catch (e) { return null; }
}
let qrScanStream = null, qrScanRafId = null, qrScanCanvas = null, qrScanVerifyMode = false, qrScanSigilMode = false, qrScanToken = 0;
async function startQrScan() {
  const myToken = ++qrScanToken; // stopQrScan() инвалидирует токен: камера, полученная после закрытия шторки, не должна остаться включённой
  const sheet = $("#scan-qr-sheet"); if (sheet) sheet.classList.remove("hidden");
  const video = $("#qr-scan-video");
  const statusEl = $("#qr-scan-status");
  if (!video || typeof jsQR !== "function") return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    if (statusEl) statusEl.textContent = T("connect.qr.scan.unsupported");
    return;
  }
  let gotStream;
  try {
    gotStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  } catch (e) {
    if (myToken !== qrScanToken) return;
    if (statusEl) statusEl.textContent = T("connect.qr.scan.noCamera");
    etherLog("warn", "[qr] getUserMedia failed:", String(e));
    return;
  }
  if (myToken !== qrScanToken || (sheet && sheet.classList.contains("hidden"))) {
    try { gotStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    return;
  }
  if (qrScanStream) { try { qrScanStream.getTracks().forEach((t) => t.stop()); } catch (e) {} }
  qrScanStream = gotStream;
  video.srcObject = qrScanStream;
  await video.play().catch(() => {});
  if (myToken !== qrScanToken) return;
  if (!qrScanCanvas) qrScanCanvas = document.createElement("canvas");
  const tick = () => {
    if (!qrScanStream) return; // сканирование уже остановлено
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      qrScanCanvas.width = video.videoWidth;
      qrScanCanvas.height = video.videoHeight;
      const ctx = qrScanCanvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, qrScanCanvas.width, qrScanCanvas.height);
      let imageData;
      try { imageData = ctx.getImageData(0, 0, qrScanCanvas.width, qrScanCanvas.height); } catch (e) { imageData = null; }
      if (imageData) {
        const result = jsQR(imageData.data, imageData.width, imageData.height);
        if (result && result.data) {
          if (qrScanVerifyMode && String(result.data).indexOf("ether://verify?n=") === 0) {
            stopQrScan(); qrScanVerifyMode = false;
            if (sheet) sheet.classList.add("hidden");
            onSafetyQrScanned(result.data);
            return;
          }
          if (qrScanSigilMode && String(result.data).indexOf("ether://sigil?p=") === 0) { // сверка общей руны пары (js/features.js)
            stopQrScan(); if (sheet) sheet.classList.add("hidden");
            if (typeof fxOnSigilQrScanned === "function") fxOnSigilQrScanned(String(result.data));
            return;
          }
          if (typeof DeviceLinkUI !== "undefined" && String(result.data).indexOf("ether://link?") === 0) { // QR переноса на новое устройство (js/devicelink.js)
            stopQrScan(); if (sheet) sheet.classList.add("hidden"); DeviceLinkUI.receiveFromCode(String(result.data)); return;
          }
          const parsed = parseQrAddPayload(result.data);
          if (parsed) {
            stopQrScan();
            if (sheet) sheet.classList.add("hidden");
            addContactFromCard(parsed.id, parsed.name);
            return;
          }
          // Invite-ссылка в группу (раздел 8/18) — та же камера сканирует
          // и её, не только обычный add-код; см. parseGroupInviteCode.
          if (parseGroupInviteCode(result.data)) {
            stopQrScan();
            if (sheet) sheet.classList.add("hidden");
            joinGroupViaInvite(result.data);
            return;
          }
        }
      }
    }
    qrScanRafId = requestAnimationFrame(tick);
  };
  qrScanRafId = requestAnimationFrame(tick);
}
function stopQrScan() {
  qrScanVerifyMode = false; qrScanSigilMode = false;
  qrScanToken++;
  if (qrScanRafId) { cancelAnimationFrame(qrScanRafId); qrScanRafId = null; }
  if (qrScanStream) { qrScanStream.getTracks().forEach((t) => t.stop()); qrScanStream = null; }
  const video = $("#qr-scan-video"); if (video) video.srcObject = null;
}
function wireQrButtons() {
  const showBtn = $("#show-my-qr-btn");
  if (showBtn) showBtn.addEventListener("click", () => {
    const sheet = $("#my-qr-sheet"); if (sheet) sheet.classList.remove("hidden");
    renderMyQrCode();
  });
  const scanBtn = $("#scan-qr-btn");
  if (scanBtn) scanBtn.addEventListener("click", () => { startQrScan(); });
  const scanSheet = $("#scan-qr-sheet");
  if (scanSheet) {
    scanSheet.querySelectorAll(".sheet-cancel, .sheet-backdrop").forEach((el) => {
      el.addEventListener("click", stopQrScan);
    });
  }
}

function wireGroupInfo() {
  const avatarBtn = $("#group-info-avatar-btn");
  const avatarInput = $("#group-info-avatar-input");
  if (avatarBtn && avatarInput) {
    avatarBtn.addEventListener("click", () => avatarInput.click());
    avatarInput.addEventListener("change", async () => {
      const file = avatarInput.files && avatarInput.files[0];
      avatarInput.value = "";
      const groupId = state.activeGroupContext; if (!file || !groupId) return;
      try {
        const dataUrl = await readImageAsAvatarDataUrl(file);
        setGroupAvatar(groupId, dataUrl);
        avatarBtn.style.backgroundImage = `url('${dataUrl}')`; avatarBtn.style.background = ""; avatarBtn.textContent = "";
      } catch (e) { toast(T("toast.avatarFailed")); }
    });
  }
  const renameInput = $("#group-info-name");
  const renameBtn = $("#group-info-rename-btn");
  if (renameBtn) renameBtn.addEventListener("click", () => {
    const groupId = state.activeGroupContext; if (!groupId) return;
    renameGroup(groupId, renameInput ? renameInput.value : "");
    toast(T("toast.saved"));
  });
  const descInput = $("#group-info-description");
  const descBtn = $("#group-info-description-btn");
  if (descBtn) descBtn.addEventListener("click", () => {
    const groupId = state.activeGroupContext; if (!groupId) return;
    setGroupDescription(groupId, descInput ? descInput.value : "");
    toast(T("toast.saved"));
  });
  const callBtn = $("#group-info-call-btn");
  if (callBtn) callBtn.addEventListener("click", () => { const gid = state.activeGroupContext; if (gid && typeof startGroupCall === "function") startGroupCall(gid, false); else toast(T("toast.callGroupsUnsupported")); });
  const writeRestrictedEl = $("#group-info-write-restricted");
  if (writeRestrictedEl) writeRestrictedEl.addEventListener("change", () => {
    const groupId = state.activeGroupContext; if (!groupId) return;
    setGroupWriteRestricted(groupId, writeRestrictedEl.checked);
  });
  const addBtn = $("#group-info-add-btn");
  if (addBtn) addBtn.addEventListener("click", () => {
    const groupId = state.activeGroupContext; const g = state.contacts.get(groupId);
    if (!g) return;
    if (g.members.length >= MAX_GROUP_MEMBERS) { toast(T("toast.groupTooBig", { max: MAX_GROUP_MEMBERS })); return; }
    const list = $("#forward-list"); if (!list) return;
    list.innerHTML = "";
    const memberIds = new Set(g.members.map((m) => m.id));
    const candidates = Array.from(state.contacts.values()).filter((c) => c.managed && !isGroup(c) && !c.isSelf && !memberIds.has(c.id));
    for (const c of candidates) {
      const row = document.createElement("button");
      row.type = "button"; row.className = "forward-row";
      row.innerHTML = `<div class="avatar avatar-sm" style="background:${avatarGradient(c.name)}">${escapeHtml(initials(c.name))}</div><span class="forward-name">${escapeHtml(c.name || T("sys.someone"))}</span>`;
      row.addEventListener("click", () => {
        const fs = $("#forward-sheet"); if (fs) fs.classList.add("hidden");
        addGroupMember(groupId, c.id);
        openGroupInfo(groupId);
      });
      list.appendChild(row);
    }
    const gis = $("#group-info-sheet"); if (gis) gis.classList.add("hidden");
    const fs = $("#forward-sheet"); if (fs) fs.classList.remove("hidden");
  });
  const leaveBtn = $("#group-info-leave-btn");
  if (leaveBtn) leaveBtn.addEventListener("click", async () => {
    const groupId = state.activeGroupContext; const g = state.contacts.get(groupId);
    if (!g) return;
    if (!await confirmSheet(T("group.confirmLeave", { name: g.name }))) return;
    removeGroupMember(groupId, Store.myId, true);
    const gis = $("#group-info-sheet"); if (gis) gis.classList.add("hidden");
    if (state.chatId === groupId) { if (typeof resetChatTransientState === "function") resetChatTransientState(null); state.chatId = null; state.multiSelect = null; renderTab(); }
  });
  const inviteLinkBtn = $("#group-info-invite-link-btn");
  if (inviteLinkBtn) inviteLinkBtn.addEventListener("click", () => {
    const groupId = state.activeGroupContext; if (!groupId) return;
    openGroupInviteSheet(groupId);
  });
  const giCopyCode = $("#group-invite-copy-btn");
  if (giCopyCode) giCopyCode.addEventListener("click", () => { const el = $("#group-invite-code-out"); if (el) copyText(el.textContent, T("toast.codeCopied")); });
}

function wireConnectScreen() {
  state._newGroupAvatar = null;
  const newGroupAvatarBtn = $("#new-group-avatar-btn");
  const newGroupAvatarInput = $("#new-group-avatar-input");
  if (newGroupAvatarBtn && newGroupAvatarInput) {
    newGroupAvatarBtn.addEventListener("click", () => newGroupAvatarInput.click());
    newGroupAvatarInput.addEventListener("change", async () => {
      const file = newGroupAvatarInput.files && newGroupAvatarInput.files[0];
      newGroupAvatarInput.value = "";
      if (!file) return;
      try {
        const dataUrl = await readImageAsAvatarDataUrl(file);
        state._newGroupAvatar = dataUrl;
        newGroupAvatarBtn.style.backgroundImage = `url('${dataUrl}')`; newGroupAvatarBtn.style.background = ""; newGroupAvatarBtn.innerHTML = "";
      } catch (e) { toast(T("toast.avatarFailed")); }
    });
  }
  const contactsSearch = $("#contacts-search");
  if (contactsSearch) contactsSearch.addEventListener("input", (e) => { state.contactsSearchQuery = e.target.value; renderContactsList(); });
  // Импорт из адресной книги (раздел 8/18 роадмапа) — navigator.contacts
  // (Contact Picker API) экспериментальный и доступен не везде (в основном
  // Chrome/Edge на Android) — классический progressive enhancement: кнопка
  // скрыта по умолчанию и появляется только там, где API реально есть, а
  // не обещана как гарантированная. У «Мессенджера» нет справочника
  // телефон↔публичный ключ (контакт добавляется только по его
  // invite-коду/QR) — поэтому выбор из телефонной книги подставляет
  // ТОЛЬКО имя, не сам id; это честно объясняется тостом сразу после
  // выбора, а не выдаётся за полноценное "добавить одним тапом".
  const importContactBtn = $("#import-contact-btn");
  if (importContactBtn && navigator.contacts && navigator.contacts.select) {
    importContactBtn.classList.remove("hidden");
    importContactBtn.addEventListener("click", async () => {
      let picked;
      try { picked = await navigator.contacts.select(["name"], { multiple: false }); }
      catch (e) { return; } // отмена выбора или отказ в доступе — ожидаемый путь, не ошибка
      const contact = picked && picked[0];
      const name = contact && Array.isArray(contact.name) && contact.name[0];
      if (!name) return;
      const nameInput = $("#add-contact-name"); if (nameInput) nameInput.value = name;
      toast(T("toast.importContactNameOnly"));
      const valueInput = $("#add-contact-value"); if (valueInput) valueInput.focus();
    });
  }
  const newGroupBtn = $("#new-group-btn");
  if (newGroupBtn) newGroupBtn.addEventListener("click", () => {
    state._newGroupAvatar = null;
    if (newGroupAvatarBtn) { newGroupAvatarBtn.style.backgroundImage = ""; newGroupAvatarBtn.style.background = "var(--accent)"; newGroupAvatarBtn.innerHTML = Icons.html("plus", 22); }
    const nameInput = $("#new-group-name"); if (nameInput) nameInput.value = "";
    const list = $("#new-group-members");
    if (list) {
      list.innerHTML = "";
      const candidates = Array.from(state.contacts.values()).filter((c) => c.managed && !isGroup(c) && !c.isSelf);
      if (candidates.length === 0) {
        const p = document.createElement("p");
        p.className = "fine muted";
        p.textContent = T("group.noContacts");
        list.appendChild(p);
      }
      for (const c of candidates) {
        const row = document.createElement("label");
        row.className = "forward-row";
        row.innerHTML = `<input type="checkbox" value="${escapeHtml(c.id)}" class="group-member-check" /><div class="avatar avatar-sm" style="background:${avatarGradient(c.name)}">${escapeHtml(initials(c.name))}</div><span class="forward-name">${escapeHtml(c.name || T("sys.someone"))}</span>`;
        list.appendChild(row);
      }
    }
    const sheet = $("#new-group-sheet"); if (sheet) sheet.classList.remove("hidden");
  });
  const newGroupCreateBtn = $("#new-group-create-btn");
  if (newGroupCreateBtn) newGroupCreateBtn.addEventListener("click", () => {
    const name = ($("#new-group-name") || {}).value || "";
    const checked = $$(".group-member-check:checked").map((el) => el.value);
    if (checked.length === 0) { toast(T("toast.groupNeedsMembers")); return; }
    if (checked.length > MAX_GROUP_MEMBERS - 1) { toast(T("toast.groupTooBig", { max: MAX_GROUP_MEMBERS })); return; }
    const groupId = createGroup(name, checked, state._newGroupAvatar);
    if (!groupId) return;
    const sheet = $("#new-group-sheet"); if (sheet) sheet.classList.add("hidden");
    if (typeof resetChatTransientState === "function") resetChatTransientState(groupId);
    state.chatId = groupId;
    renderTab();
  });
  const addBtn = $("#add-contact-btn");
  const addValEl = $("#add-contact-value");
  if (addValEl) addValEl.addEventListener("input", () => {
    const v = addValEl.value.trim();
    if (!v) { addValEl.classList.remove("input-invalid"); return; }
    // Invite-ссылка в группу (раздел 8/18) вставляется в то же самое
    // поле, что и обычный id/email/телефон — она заведомо не пройдёт
    // Identity.idFor (это не контактный идентификатор), так что проверяем
    // её отдельно, иначе поле подсвечивалось бы красным на валидном коде.
    if (v.indexOf("ether://group?") === 0) { addValEl.classList.remove("input-invalid"); return; }
    Identity.idFor(v).then(
      () => addValEl.classList.remove("input-invalid"),
      () => addValEl.classList.add("input-invalid")
    );
  });
  if (addBtn) addBtn.addEventListener("click", async () => {
    const nameVal = $("#add-contact-name").value.trim();
    const raw = $("#add-contact-value").value.trim();
    if (!raw) { toast(T("toast.emptyId")); return; }
    if (raw.indexOf("ether://group?") === 0) {
      await joinGroupViaInvite(raw);
      $("#add-contact-name").value = ""; $("#add-contact-value").value = "";
      return;
    }
    let identity;
    try { identity = await Identity.idFor(raw); }
    catch (e) { toast(T(e.message)); if (addValEl) addValEl.classList.add("input-invalid"); return; }
    if (identity.id === Store.myId) { toast(T("toast.ownId")); return; }
    if (state.contacts.has(identity.id)) toast(T("toast.alreadyAdded"));
    else {
      if (recentlyDeletedIds.delete(identity.id)) persistRecentlyDeleted(); // осознанное повторное добавление снимает блокировку из deleteContact
      state.contacts.set(identity.id, {
        id: identity.id, name: nameVal || identity.normalized, raw: identity.normalized,
        managed: true, publicKey: null, online: onlineSet.has(identity.id),
        status: "disconnected", messages: [], lastActivity: Date.now(),
        archived: false, muted: false, blocked: false,
      });
      persistContacts();
      toast(T("toast.contactAdded"));
      if (onlineSet.has(identity.id)) scheduleAutoConnect(identity.id);
    }
    $("#add-contact-name").value = "";
    $("#add-contact-value").value = "";
    state.tab = "chats"; renderTab();
  });
  const toggleManual = $("#toggle-manual-btn");
  if (toggleManual) toggleManual.addEventListener("click", () => {
    const sec = $("#manual-section");
    sec.classList.toggle("hidden");
    toggleManual.textContent = sec.classList.contains("hidden") ? T("connect.manual") : T("connect.manual.hide");
  });
  const createBtn = $("#create-invite-btn");
  if (createBtn) createBtn.addEventListener("click", createInvite);
  const copyCode = $("#copy-code-btn");
  if (copyCode) copyCode.addEventListener("click", () => { const el = $("#invite-code-out"); if (el) copyText(el.textContent, T("toast.codeCopied")); });
  const copyLink = $("#copy-link-btn");
  if (copyLink) copyLink.addEventListener("click", () => { const el = $("#invite-link-out"); if (el) copyText(el.textContent, T("toast.linkCopied")); });
  const share = $("#share-link-btn");
  if (share) share.addEventListener("click", async () => {
    const el = $("#invite-link-out"); if (!el) return;
    const url = el.textContent;
    if (navigator.share) { try { await navigator.share({ title: T("app.name"), url }); } catch (e) {} }
    else copyText(url, T("toast.linkCopied"));
  });
  const completeBtn = $("#complete-invite-btn");
  if (completeBtn) completeBtn.addEventListener("click", async () => {
    const code = $("#answer-code-in").value.trim();
    if (!code || !state.pendingOutgoing) return;
    try {
      const packet = await SignalingCodec.decode(code);
      if (packet.t !== "answer") throw new Error("toast.badInviteCode");
      const link = mesh.get(state.pendingOutgoing.id);
      if (!link) { resetConnectScreen(); return; }
      await link.acceptAnswer(packet);
      $("#answer-code-in").value = "";
      toast(T("toast.callAccepted"));
    } catch (e) { toast(T("toast.badInviteCode")); }
  });
  const replyBtn = $("#reply-btn");
  if (replyBtn) replyBtn.addEventListener("click", async () => {
    const code = $("#paste-code-in").value.trim();
    if (!code) return;
    try { await handleIncomingCode(code); } catch (e) { toast(T("toast.badInviteCode")); }
  });
  const newInvite = $("#new-invite-again");
  if (newInvite) newInvite.addEventListener("click", resetConnectScreen);
  const answerCopy = $("#answer-copy-btn");
  if (answerCopy) answerCopy.addEventListener("click", () => { const el = $("#answer-out-code"); if (el) copyText(el.textContent, T("toast.codeCopied")); });
}
function resetConnectScreen() {
  // Временный контакт (managed:false, status:"awaiting-answer"/"connecting")
  // создаётся в createInvite() под тем же id, что лежит в
  // state.pendingOutgoing. Раньше при отмене приглашения ("Начать
  // заново") эта запись просто оставалась висеть в state.contacts
  // навсегда (в памяти — на persist она и так не шла, но накапливалась
  // при многократных отменах). Проверяем именно status !== "connected":
  // этот же resetConnectScreen() вызывается и при УСПЕШНОМ подключении
  // (см. wireMeshEvents), где контакт уже настоящий — его трогать нельзя.
  if (state.pendingOutgoing) {
    const c = state.contacts.get(state.pendingOutgoing.id);
    if (c && !c.managed && c.status !== "connected" && c.status !== "in-call") {
      state.contacts.delete(state.pendingOutgoing.id);
    }
  }
  state.pendingOutgoing = null;
  const ii = $("#invite-idle"); if (ii) ii.classList.remove("hidden");
  const ia = $("#invite-active"); if (ia) ia.classList.add("hidden");
  const ac = $("#answer-code-in"); if (ac) ac.value = "";
  const pc = $("#paste-code-in"); if (pc) pc.value = "";
  const ib = $("#incoming-banner"); if (ib) ib.classList.add("hidden");
}
let __createInviteBusy = false;
async function createInvite() {
  if (__createInviteBusy) return; // повторный вызов во время генерации оффера плодил бы осиротевшие линки/контакты
  __createInviteBusy = true;
  try { await createInviteInner(); } finally { __createInviteBusy = false; }
}
async function createInviteInner() {
  const id = crypto.randomUUID();
  const link = mesh.createOutgoingLink(id);
  const packet = await link.createInitialOffer("");
  if (!packet) {
    // createInitialOffer() может вернуть null, если соединение уже
    // закрыто в процессе — без этой проверки SignalingCodec.encode(null)
    // не падает, а тихо кодирует мусор из строки "null", и пользователь
    // получает нерабочее приглашение без единого сообщения об ошибке.
    mesh.remove(id);
    toast(T("toast.inviteFailed"));
    return;
  }
  const code = await SignalingCodec.encode(packet);
  const shareLink = SignalingCodec.buildShareLink(code);
  state.pendingOutgoing = { id, code, shareLink };
  state.contacts.set(id, { id, name: "…", raw: "", managed: false, online: false, status: "awaiting-answer", messages: [], lastActivity: Date.now(), archived: false, muted: false, blocked: false });
  const ii = $("#invite-idle"); if (ii) ii.classList.add("hidden");
  const ia = $("#invite-active"); if (ia) ia.classList.remove("hidden");
  const co = $("#invite-code-out"); if (co) co.textContent = code;
  const lo = $("#invite-link-out"); if (lo) lo.textContent = shareLink;
}
async function handleIncomingCode(code) {
  let packet;
  try { packet = await SignalingCodec.decode(code); }
  catch (e) { throw new Error("bad invite code"); } // вызывающие показывают toast.badInviteCode
  if (!packet || packet.t !== "offer") throw new Error("not an offer");
  {
    if (!packet.d || typeof packet.d.sdp !== "string") throw new Error("bad offer");
    const id = crypto.randomUUID();
    let link;
    try {
      link = mesh.createIncomingLink(id);
      const answerPacket = await link.acceptOfferAndCreateAnswer(packet);
      const answerCode = await SignalingCodec.encode(answerPacket);
      state.contacts.set(id, { id, name: (typeof packet.n === "string" ? packet.n.slice(0, 40) : "") || T("sys.someone"), raw: "", managed: false, online: false, status: "connecting", messages: [], lastActivity: Date.now(), archived: false, muted: false, blocked: false });
      state.tab = "connect"; renderTab();
      const ms = $("#manual-section"); if (ms) ms.classList.remove("hidden");
      const tm = $("#toggle-manual-btn"); if (tm) tm.textContent = T("connect.manual.hide");
      const ib = $("#incoming-banner"); if (ib) ib.classList.remove("hidden");
      const ibt = $("#incoming-banner-text"); if (ibt) ibt.textContent = typeof packet.n === "string" ? packet.n.slice(0, 40) : "";
      const aoc = $("#answer-out-code"); if (aoc) aoc.textContent = answerCode;
      const aow = $("#answer-out-wrap"); if (aow) aow.classList.remove("hidden");
      const pcw = $("#paste-code-wrap"); if (pcw) pcw.classList.add("hidden");
    } catch (e) {
      try { mesh.remove(id); } catch (e2) {}
      state.contacts.delete(id);
      throw e;
    }
  }
}
function copyText(text, msg) {
  if (navigator.clipboard) {
    try { navigator.clipboard.writeText(text).then(() => toast(msg)).catch(() => toast(T("toast.copyFailed"))); }
    catch (e) { toast(T("toast.copyFailed")); }
  }
  else {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = !!(document.execCommand && document.execCommand("copy")); } catch (e) {}
    // execCommand не бросает при неудаче, а возвращает false — раньше тут всегда показывалось «скопировано».
    toast(ok ? msg : T("toast.copyFailed"));
    ta.remove();
  }
}

// =====================================================================
// Шиты
// =====================================================================
function wireCameraButton() {
  // Кнопка "Камера" в чате открывает СИСТЕМНУЮ камеру через
  // <input type="file" accept="image/*" capture="environment">
  // (обработчик change для #chat-camera-input подключён отдельно, в
  // startApp). Самодельный виджет-камера (запись видео, flip, таймер)
  // был удалён как мёртвый код: он нигде не вызывался, а видеозвонки
  // используют PeerLink.enableVideo() напрямую, без этого виджета.
  const openBtn = $("#chat-camera-btn");
  const cameraInput = $("#chat-camera-input");
  if (!cameraInput || !openBtn) return;
  openBtn.addEventListener("click", () => {
    if (!state.chatId) return;
    cameraInput.value = "";
    cameraInput.click();
  });
}
// =====================================================================
// Единое подтверждение необратимых действий (раздел 15 роадмапа, "мои
// добавления" — "единообразный паттерн подтверждающего шторки, а не
// confirm()"). native confirm() блокирует весь поток JS, выглядит
// по-разному на каждой платформе и не поддаётся кастомному стилю — заменён
// везде в этом релизе на один переиспользуемый #confirm-sheet. Промис-
// обёртка — тот же приём, что уже был у openBackupPasswordSheet() (см.
// ниже по файлу): MutationObserver перехватывает закрытие ЛЮБЫМ путём
// (backdrop, Esc через общий wireEscCloseAnySheet, фокус-менеджмент), а
// не только через свои кнопки — иначе промис мог бы повиснуть навечно,
// если пользователь закрыл шторку мимо кнопок.
let __confirmSheetResolve = null;
function confirmSheet(message, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const sheet = $("#confirm-sheet");
    if (!sheet) { resolve(false); return; } // шторки нет в DOM (не должно случаться) — не блокируем действие молча навсегда
    if (__confirmSheetResolve) { const prev = __confirmSheetResolve; __confirmSheetResolve = null; try { prev(false); } catch (e) {} } // предыдущий вопрос не должен висеть вечно
    __confirmSheetResolve = resolve;
    const msgEl = $("#confirm-sheet-message"); if (msgEl) msgEl.textContent = message;
    const okBtn = $("#confirm-sheet-ok"); if (okBtn) { okBtn.classList.toggle("destructive", !!opts.destructive); okBtn.textContent = opts.okLabel || T("sys.confirm"); }
    const cancelBtn0 = $("#confirm-sheet-cancel"); if (cancelBtn0) cancelBtn0.textContent = opts.cancelLabel || T("sys.cancel");
    sheet.classList.remove("hidden");
  });
}
let __confirmSheetWired = false;
// edit/delete с payload.groupId применяются к группе (и только если
// отправитель — её участник), иначе — к 1:1 чату с отправителем.
function resolveEditDeleteTarget(from, payload) {
  if (payload && payload.groupId) {
    const g = state.contacts.get(payload.groupId);
    if (!g || !isGroup(g) || !Array.isArray(g.members) || !g.members.some((m) => m.id === from)) return null;
    return g;
  }
  return ensureContactEntry(from, null);
}
function wireConfirmSheet() {
  if (__confirmSheetWired) return;
  __confirmSheetWired = true;
  const sheet = $("#confirm-sheet"); if (!sheet) return;
  const okBtn = $("#confirm-sheet-ok");
  const cancelBtn = $("#confirm-sheet-cancel");
  const settle = (result) => {
    const resolve = __confirmSheetResolve;
    if (!resolve) return; // уже резолвлено
    __confirmSheetResolve = null;
    sheet.classList.add("hidden");
    resolve(result);
  };
  if (okBtn) okBtn.addEventListener("click", () => settle(true));
  if (cancelBtn) cancelBtn.addEventListener("click", () => settle(false));
  // wireSheetBackdrops/wireEscCloseAnySheet подключаются только в
  // startApp() — на экране блокировки их ещё нет.
  const backdrop = sheet.querySelector(".sheet-backdrop");
  if (backdrop) backdrop.addEventListener("click", () => settle(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !sheet.classList.contains("hidden")) settle(false);
  });
  new MutationObserver(() => {
    if (sheet.classList.contains("hidden")) settle(false); // любое другое закрытие — считаем отменой, не подтверждением
  }).observe(sheet, { attributes: true, attributeFilter: ["class"] });
}
function wireSheetBackdrops() {
  $$(".sheet-backdrop").forEach((el) => {
    el.addEventListener("click", () => { const s = el.closest(".sheet"); if (s) s.classList.add("hidden"); });
  });
  $$(".sheet-cancel").forEach((btn) => {
    btn.addEventListener("click", () => { const id = btn.dataset.closeSheet; if (id) { const el = $("#" + id); if (el) el.classList.add("hidden"); } });
  });
  // Ручка (.sheet-handle) была чисто декоративной — визуально обещает
  // "потяни, чтобы закрыть" (знакомый паттерн из iOS/Telegram/WhatsApp),
  // но ничего не делала. Жест только на самой ручке (не на всей панели)
  // — безопасно, не может конфликтовать со скроллом контента внутри
  // шторки (.sheet-panel сам по себе прокручиваемый).
  $$(".sheet-handle").forEach((handle) => {
    let startY = 0, dragging = false, panel = null;
    handle.addEventListener("touchstart", (e) => {
      startY = e.touches[0].clientY;
      dragging = true;
      panel = handle.closest(".sheet-panel");
      if (panel) panel.style.transition = "none";
    }, { passive: true });
    handle.addEventListener("touchmove", (e) => {
      if (!dragging || !panel) return;
      const dy = Math.max(0, e.touches[0].clientY - startY);
      panel.style.transform = `translateY(${dy}px)`;
    }, { passive: true });
    handle.addEventListener("touchend", (e) => {
      if (!dragging) return;
      dragging = false;
      const dy = Math.max(0, (e.changedTouches[0] ? e.changedTouches[0].clientY : startY) - startY);
      if (panel) {
        panel.style.transition = "";
        panel.style.transform = "";
      }
      if (dy > 60) { const s = handle.closest(".sheet"); if (s) s.classList.add("hidden"); }
    });
  });
}
// V.79: отдельная плавающая панель реакций удалена — дублировала ряд реакций в шторке сообщения; долгое нажатие открывает шторку.
// Ряд быстрых реакций (6 частых + «ещё») в шторке сообщения (#reaction-bar).
function fillReactionRow(row, msgId, contactId, anchorEl, done) {
  const DEFAULT_QUICK_REACTIONS = ["❤️", "👍", "👎", "😂", "😮", "😢"];
  const recent = Store.recentReactions;
  const quickSet = (recent.length > 0 ? recent : DEFAULT_QUICK_REACTIONS).slice(0, 6);
  quickSet.forEach((emoji) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "reaction-emoji"; b.textContent = emoji;
    b.setAttribute("aria-label", emoji);
    b.addEventListener("click", () => {
      done();
      toggleReaction(contactId, msgId, emoji);
      if (anchorEl) spawnReactionBurst(anchorEl, emoji);
    });
    row.appendChild(b);
  });
  const plus = document.createElement("button");
  plus.type = "button"; plus.className = "reaction-emoji reaction-expand";
  plus.setAttribute("aria-label", T("chat.reactionMore")); plus.textContent = "+";
  plus.addEventListener("click", () => {
    done();
    openEmojiPicker({ closeOnPick: true, onPick: (emoji) => { recordRecentReaction(emoji); toggleReaction(contactId, msgId, emoji); } });
  });
  row.appendChild(plus);
}
function openMessageSheet(msgId, contactId) {
  state.activeMessageContext = { msgId, contactId };
  const c = state.contacts.get(contactId); if (!c) return;
  const m = c.messages.find((x) => x.id === msgId); if (!m) return;
  const groupCtx = isGroup(c);
  // Ряд быстрых реакций над действиями (только личные чаты); и тап, и долгое нажатие по сообщению открывают эту шторку.
  const bar = $("#reaction-bar");
  if (bar) {
    bar.innerHTML = ""; bar.classList.toggle("hidden", groupCtx);
    if (!groupCtx) {
      bar.setAttribute("aria-label", T("chat.reactionsAria"));
      const row = Array.from(document.querySelectorAll("[data-msg-id]")).find((x) => x.dataset.msgId === msgId), bub = row && (row.querySelector(".bubble") || row);
      fillReactionRow(bar, msgId, contactId, bub, () => { const ms = $("#message-sheet"); if (ms) ms.classList.add("hidden"); });
    }
  }
  const isOwn = m.from === "me";
  const body = $("#message-sheet-body"); if (!body) return;
  const act = (name, label, cls) => `<button type="button" class="sheet-action${cls ? " " + cls : ""}" data-action="${name}">${escapeHtml(label)}</button>`;
  // Уровень 2 (основные): ответить, переслать, копировать, закрепить.
  const main = [act("reply", T("chat.reply")), act("forward", T("chat.forward")), act("copy", T("chat.copy")), act("pin", c.pinnedMessageId === msgId ? T("chat.unpinMsg") : T("chat.pinMsg"))];
  // Уровень 3 (редкие): перевод, избранное, выбор, правка, удаление. «Повторить» — тапом по значку «не доставлено» у самого сообщения.
  // Пересылка/правка/«удалить у всех» рассчитаны на одного получателя, поэтому в группах не предлагаются; локальные действия безопасны всегда.
  const rare = [];
  if (m.text && !m.file && !m.sticker && !m.contactCard && !m.poll && !m.board && !m.note) rare.push(act("translate", m.translation ? T("chat.translate.hide") : T("chat.translate")));
  rare.push(act("favorite", m.favorite ? T("chat.unfavorite") : T("chat.favorite")));
  if (!m.board || m.text) { rare.push(act("task", T("chat.toTask"))); rare.push(act("remind", T("chat.remind"))); }
  rare.push(act("thread", T("chat.thread.open")));
  if (typeof LocalAI !== "undefined" && messageSummarySource(m).length >= 200) rare.push(act("summary", T("ai.summary")));
  rare.push(act("select", T("chat.selectMsgs")));
  if (isOwn && !m.file && !m.sticker && !m.contactCard && !m.poll && !m.board && !m.note) rare.push(act("edit", T("chat.edit")));
  rare.push(act("delete-local", T("chat.delete.local"), "destructive"));
  if (isOwn) rare.push(act("delete-both", T("chat.delete.both"), "destructive"));
  const actions = [...main, `<div class="sheet-divider" role="separator"></div>`, ...rare];
  body.innerHTML = actions.join("");
  body.querySelectorAll(".sheet-action").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      const ms = $("#message-sheet"); if (ms) ms.classList.add("hidden");
      handleMessageAction(action, msgId, contactId);
    });
  });
  const ms = $("#message-sheet"); if (ms) ms.classList.remove("hidden");
}
async function handleMessageAction(action, msgId, contactId) {
  const c = state.contacts.get(contactId); if (!c) return;
  const m = c.messages.find((x) => x.id === msgId); if (!m) return;
  if (action === "copy") { copyText(m.text || "", T("toast.msgCopied")); flashCopiedBubble(msgId); }
  else if (action === "thread") openThread(contactId, msgId);
  else if (action === "summary") openSummarySheet(messageSummarySource(m));
  else if (action === "edit") startEditing(msgId);
  else if (action === "delete-local") deleteMessageLocal(contactId, msgId);
  else if (action === "delete-both") {
    if (!await confirmSheet(T("chat.delete.both") + "?", { destructive: true })) return;
    await deleteMessageForBoth(contactId, msgId);
  } else if (action === "reply") {
    state.replyTo = { msgId: m.id, text: m.text, from: m.from, authorName: m.from === "me" ? (Store.name || "") : (m.fromName || c.name || "") };
    showReplyBanner();
    const inp = $("#chat-input"); if (inp) inp.focus();
  } else if (action === "forward") openForwardSheet((toId) => forwardMessage(msgId, contactId, toId));
  else if (action === "retry") retryMessage(contactId, msgId);
  else if (action === "pin") togglePinnedMessage(contactId, msgId);
  else if (action === "select") enterMultiSelect(msgId);
  else if (action === "favorite") toggleMessageFavorite(contactId, msgId);
  else if (action === "translate") translateMessage(contactId, msgId);
  else if (action === "task") createTaskFromMessage(contactId, msgId);
  else if (action === "remind") openRemindSheet(contactId, msgId);
}
// Универсальная шторка действий (#action-sheet): список {label, icon, danger, fn}; закрывается перед вызовом fn.
function openActionSheet(title, items) {
  const sheet = $("#action-sheet"), body = $("#action-sheet-body"); if (!sheet || !body) return;
  const t = $("#action-sheet-title"); if (t) { t.textContent = title || ""; t.classList.toggle("hidden", !title); }
  body.innerHTML = "";
  for (const it of items) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "sheet-action" + (it.danger ? " destructive" : "");
    b.style.minHeight = "44px";
    b.innerHTML = (it.icon ? Icons.html(it.icon, 20) : "") + `<span>${escapeHtml(it.label)}</span>`;
    b.addEventListener("click", () => { sheet.classList.add("hidden"); if (it.fn) it.fn(); });
    body.appendChild(b);
  }
  sheet.classList.remove("hidden");
}
// ===== V.79: единый якорное всплывающее меню. Один помощник на все меню у кнопки/строки: позиционирование (RTL, safe-area, клавиатура через
// visualViewport), закрытие по клику снаружи / Esc / «назад» (popstate) / прокрутке, ловушка фокуса, слой --z-popover.
// openAnchoredMenu({ anchor | point:{x,y}, items:[{label, icon, danger, rare, fn}], title, align:"start"|"end"|"center", side:"auto"|"up"|"down", onClose })
// items с rare:true в простом режиме прячутся под пунктом «Ещё» (в полном — показаны сразу). Возвращает { el, close }.
// positionAnchored(panel, anchor, opts) и bindMenuDismiss(panel, opts) — те же части отдельно: ими пользуется «+» композера (его панель — статичная шторка).
let __anchoredMenu = null;
function __safeAreaInsets() {
  const out = { top: 0, bottom: 0 };
  try {
    let p = document.getElementById("safe-area-probe");
    if (!p) { p = document.createElement("div"); p.id = "safe-area-probe"; p.setAttribute("aria-hidden", "true"); p.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)"; document.body.appendChild(p); }
    const cs = getComputedStyle(p); out.top = parseFloat(cs.paddingTop) || 0; out.bottom = parseFloat(cs.paddingBottom) || 0;
  } catch (e) {}
  return out;
}
function positionAnchored(panel, anchor, opts) {
  opts = opts || {};
  const rtl = (document.documentElement.dir || "ltr") === "rtl", pad = opts.pad == null ? 8 : opts.pad, gap = opts.gap == null ? 8 : opts.gap;
  const vv = window.visualViewport, vw = window.innerWidth || 360, vTop = vv ? vv.offsetTop : 0, vh = vv ? vv.height + vv.offsetTop : (window.innerHeight || 640);
  const sa = __safeAreaInsets();
  const a = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: opts.x || 0, right: opts.x || 0, top: opts.y || 0, bottom: opts.y || 0, width: 0, height: 0 };
  const minTop = vTop + sa.top + pad, maxBottom = vh - sa.bottom - pad;
  panel.style.maxHeight = Math.max(120, Math.round(maxBottom - minTop)) + "px";
  const pw = Math.min(panel.offsetWidth || 0, vw - 2 * pad), ph = Math.min(panel.offsetHeight || 0, maxBottom - minTop);
  const align = opts.align || "start";
  let left = align === "center" ? a.left + a.width / 2 - pw / 2 : (align === "end") !== rtl ? a.right - pw : a.left;
  left = Math.max(pad, Math.min(left, vw - pw - pad));
  const spaceBelow = maxBottom - (a.bottom + gap), spaceAbove = (a.top - gap) - minTop;
  const down = opts.side === "down" ? true : opts.side === "up" ? false : (spaceBelow >= ph || spaceBelow >= spaceAbove);
  let top = down ? a.bottom + gap : a.top - gap - ph;
  top = Math.max(minTop, Math.min(top, maxBottom - ph));
  const org = opts.origin ? { l: opts.origin.left, t: opts.origin.top } : { l: 0, t: 0 }; // origin — рамка, относительно которой абсолютно позиционируется панель (шторка внутри #app-shell)
  panel.style.left = Math.round(left - org.l) + "px"; panel.style.top = Math.round(top - org.t) + "px";
  panel.dataset.side = down ? "down" : "up";
  return { left, top, down };
}
// Закрытие снаружи / Esc / назад / прокрутка + ловушка фокуса (Tab циклит внутри, стрелки двигают фокус). Возвращает функцию снятия слушателей.
function bindMenuDismiss(panel, opts) {
  opts = opts || {};
  const close = opts.close, owns = (t) => panel.contains(t) || (opts.anchor && opts.anchor.contains && opts.anchor.contains(t));
  const focusables = () => Array.from(panel.querySelectorAll(opts.itemSel || "button:not([disabled]), [href], input, select, textarea")).filter((el) => !el.closest(".hidden") && !el.disabled);
  const onDown = (e) => { if (!owns(e.target)) close("outside"); };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); close("escape"); return; }
    const list = focusables(); if (!list.length) return;
    const i = list.indexOf(document.activeElement);
    if (e.key === "Tab") { e.preventDefault(); const n = e.shiftKey ? (i <= 0 ? list.length - 1 : i - 1) : (i === list.length - 1 ? 0 : i + 1); list[n].focus(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); const n = e.key === "ArrowDown" ? (i + 1) % list.length : (i <= 0 ? list.length - 1 : i - 1); list[n].focus(); }
    else if (e.key === "Home") { e.preventDefault(); list[0].focus(); }
    else if (e.key === "End") { e.preventDefault(); list[list.length - 1].focus(); }
  };
  const onBack = () => close("back");
  const onScroll = (e) => { if (!panel.contains(e.target)) close("scroll"); }; // колесо/свайп вне меню: список под ним уезжает — меню закрывается
  const t = setTimeout(() => { document.addEventListener("pointerdown", onDown, true); }, 0); // pointerdown, открывший меню, не должен его сразу закрыть
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("popstate", onBack); window.addEventListener("hashchange", onBack); window.addEventListener("resize", onBack); window.addEventListener("orientationchange", onBack);
  window.addEventListener("wheel", onScroll, { capture: true, passive: true }); window.addEventListener("touchmove", onScroll, { capture: true, passive: true });
  return () => {
    clearTimeout(t);
    document.removeEventListener("pointerdown", onDown, true); document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("popstate", onBack); window.removeEventListener("hashchange", onBack); window.removeEventListener("resize", onBack); window.removeEventListener("orientationchange", onBack);
    window.removeEventListener("wheel", onScroll, true); window.removeEventListener("touchmove", onScroll, true);
  };
}
function closeAnchoredMenu(reason) {
  const m = __anchoredMenu; if (!m) return;
  __anchoredMenu = null;
  try { m.unbind(); } catch (e) {}
  try { m.el.remove(); } catch (e) {}
  if (m.anchor && m.anchor.setAttribute && m.anchor.hasAttribute && m.anchor.hasAttribute("aria-expanded")) m.anchor.setAttribute("aria-expanded", "false");
  if (reason !== "action" && m.anchor && m.anchor.focus && reason !== "outside" && reason !== "scroll") { try { m.anchor.focus({ preventScroll: true }); } catch (e) {} }
  try { if (m.onClose) m.onClose(reason || "close"); } catch (e) {}
}
function openAnchoredMenu(o) {
  o = o || {};
  closeAnchoredMenu("replace");
  const el = document.createElement("div");
  el.id = "anchored-menu"; el.className = "anchored-menu glass-content"; el.setAttribute("role", "menu");
  if (o.title) el.setAttribute("aria-label", o.title);
  const items = (o.items || []).filter(Boolean);
  const hasRare = isSimpleUi() && items.some((it) => it.rare);
  let html = o.title ? `<div class="amenu-title">${escapeHtml(o.title)}</div>` : "";
  items.forEach((it, i) => {
    html += `<button type="button" role="menuitem" class="sheet-action amenu-item${it.danger ? " destructive" : ""}${it.rare && hasRare ? " amenu-rare hidden" : ""}" data-i="${i}">${it.icon ? Icons.html(it.icon, 20) : ""}<span>${escapeHtml(it.label)}</span></button>`;
  });
  if (hasRare) html += `<button type="button" role="menuitem" class="sheet-action amenu-item amenu-more" aria-expanded="false">${Icons.html("chevron-down", 20)}<span>${escapeHtml(T("menu.more"))}</span></button>`;
  el.innerHTML = html;
  document.body.appendChild(el);
  const anchor = o.anchor || null;
  if (anchor && anchor.setAttribute) { anchor.setAttribute("aria-expanded", "true"); if (!anchor.hasAttribute("aria-haspopup")) anchor.setAttribute("aria-haspopup", "menu"); }
  const place = () => positionAnchored(el, anchor, { x: o.point && o.point.x, y: o.point && o.point.y, align: o.align || "end", side: o.side || "auto" });
  place();
  const handle = { el, close: (r) => closeAnchoredMenu(r || "close") };
  const unbindDismiss = bindMenuDismiss(el, { anchor, close: (r) => closeAnchoredMenu(r) });
  __anchoredMenu = { el, anchor, onClose: o.onClose, unbind: unbindDismiss };
  el.addEventListener("click", (e) => {
    const b = e.target.closest(".amenu-item"); if (!b || !el.contains(b)) return;
    if (b.classList.contains("amenu-more")) {
      el.querySelectorAll(".amenu-rare").forEach((x) => x.classList.remove("hidden")); b.remove(); place();
      const f = el.querySelector(".amenu-rare"); if (f) { try { f.focus({ preventScroll: true }); } catch (err) {} }
      return;
    }
    const it = items[Number(b.dataset.i)]; closeAnchoredMenu("action"); if (it && it.fn) it.fn();
  });
  const first = el.querySelector(".amenu-item"); if (first) { try { first.focus({ preventScroll: true }); } catch (e) {} }
  return handle;
}
// «Создать задачу из сообщения»: карточка в колонке «К выполнению» первой доски чата (доски нет — создаётся).
async function createTaskFromMessage(contactId, msgId) {
  const c = state.contacts.get(contactId); const m = c && c.messages.find((x) => x.id === msgId); if (!m) return;
  const text = (m.text || (m.file && m.file.name) || "").trim().slice(0, 120);
  if (!text) { toast(T("chat.toTask.empty")); return; }
  const findBoard = () => c.messages.find((x) => x.board && !x.deleted);
  let bm = findBoard();
  if (!bm) { if (!await createBoard(contactId, T("chat.board.defaultTitle"))) return; bm = findBoard(); }
  if (!bm || !bm.board || !bm.board.cols.length) return;
  await boardOp(contactId, bm.id, { t: "add", card: { id: crypto.randomUUID(), t: text, col: bm.board.cols[0].id } });
  toast(T("chat.toTask.done"));
}
// Напоминания о сообщениях: локально (localStorage), проверка таймером при открытом приложении и при запуске.
function loadReminders() { try { const a = JSON.parse(localStorage.getItem("ether.reminders") || "[]"); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
function saveReminders(a) { try { localStorage.setItem("ether.reminders", JSON.stringify(a.slice(-100))); } catch (e) {} }
function addReminder(contactId, msgId, at) {
  const c = state.contacts.get(contactId); const m = c && c.messages.find((x) => x.id === msgId); if (!m) return;
  const a = loadReminders(); a.push({ id: crypto.randomUUID(), contactId, msgId, at, name: c.name || "", text: String(m.text || (m.file && m.file.name) || "").slice(0, 80) });
  saveReminders(a); toast(T("chat.remind.set"));
}
function openRemindSheet(contactId, msgId) {
  const now = Date.now(), tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 0, 0, 0);
  openActionSheet(T("chat.remind"), [
    { label: T("chat.remind.15m"), icon: "clock", fn: () => addReminder(contactId, msgId, now + 15 * 60000) },
    { label: T("chat.remind.1h"), icon: "clock", fn: () => addReminder(contactId, msgId, now + 3600000) },
    { label: T("chat.remind.3h"), icon: "clock", fn: () => addReminder(contactId, msgId, now + 3 * 3600000) },
    { label: T("chat.remind.tomorrow"), icon: "clock", fn: () => addReminder(contactId, msgId, tomorrow.getTime()) },
  ]);
}
function checkReminders() {
  const a = loadReminders(); if (!a.length) return;
  const now = Date.now(), due = a.filter((r) => r.at <= now);
  if (!due.length) return;
  saveReminders(a.filter((r) => r.at > now));
  for (const r of due) {
    toast(T("chat.remind.due", { name: r.name || T("sys.someone"), text: r.text }));
    try { showNotification(r.name || T("sys.someone"), r.text, { contactId: r.contactId, kind: "message", tag: "remind-" + r.id, force: true }); } catch (e) {}
  }
}
function wireReminders() { checkReminders(); setInterval(checkReminders, 20000); }
function toggleMessageFavorite(contactId, msgId) {
  const c = state.contacts.get(contactId); if (!c) return;
  const m = c.messages.find((x) => x.id === msgId); if (!m) return;
  m.favorite = !m.favorite;
  persistContacts();
  if (state.chatId === contactId) renderChatThreadInner();
  updateFavoritesCount();
  toast(m.favorite ? T("toast.favoriteAdded") : T("toast.favoriteRemoved"));
}
// =====================================================================
// Перевод сообщений через сервер (раздел 5 роадмапа)
// =====================================================================
// On-device перевод (Chrome Translator API) — Chrome-only экспериментальный
// API за флагом, недоступен в Safari/Firefox/большинстве мобильных
// браузеров (см. раздел 14/16) — не годится как основной путь для
// приложения на 72 языках. Поэтому основной путь — серверный, через любой
// LibreTranslate-совместимый эндпоинт, который пользователь укажет сам в
// Settings (по умолчанию DEFAULT_TRANSLATE_ENDPOINT, см. Store.translateEndpoint) — текст
// сообщения уходит именно на этот сервер в открытом виде, точно так же,
// как ссылка уходит на сигнальный сервер для link-preview, и это явно
// объясняется рядом с полем в Settings, а не скрывается.
const _translateInFlight = new Set();
async function translateMessage(contactId, msgId) {
  const c = state.contacts.get(contactId); if (!c) return;
  const m = c.messages.find((x) => x.id === msgId); if (!m || !m.text) return;
  if (m.translation) { // повторный тап на уже переведённом — скрыть перевод, не перезапрашивать
    delete m.translation;
    if (state.chatId === contactId) renderChatThreadInner();
    return;
  }
  const endpoint = Store.translateEndpoint;
  if (!endpoint) { toast(T("toast.translateNoServer")); return; }
  if (_translateInFlight.has(msgId)) return;
  _translateInFlight.add(msgId);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ q: m.text, source: "auto", target: (I18N.current || "en").split("-")[0], format: "text" }, Store.translateApiKey ? { api_key: Store.translateApiKey } : {})),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error("http " + res.status);
    const data = await res.json();
    const translated = data && (data.translatedText || data.translated_text);
    if (!translated || typeof translated !== "string") throw new Error("empty");
    m.translation = { text: translated };
    if (state.chatId === contactId) renderChatThreadInner();
  } catch (e) {
    toast(T("toast.translateFailed"));
  } finally {
    _translateInFlight.delete(msgId);
  }
}
function updateFavoritesCount() {
  const el = $("#settings-favorites-count"); if (!el) return;
  let n = 0;
  for (const c of state.contacts.values()) for (const m of c.messages) if (m.favorite) n++;
  el.textContent = n > 0 ? String(n) : "";
}
// Шторка "Избранные сообщения" в Settings — собирает m.favorite из ВСЕХ
// чатов (не только текущего), иначе звёздочка на пузыре была бы
// фичей без единой точки, где эти сообщения реально можно найти позже.
function openFavoritesSheet() {
  const list = $("#favorites-list"); if (!list) return;
  list.innerHTML = "";
  const rows = [];
  for (const c of state.contacts.values()) {
    for (const m of c.messages) {
      if (m.favorite) rows.push({ contactId: c.id, contactName: c.name || T("sys.someone"), msg: m });
    }
  }
  rows.sort((a, b) => b.msg.ts - a.msg.ts);
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "fine muted";
    empty.textContent = T("settings.favorites.empty");
    list.appendChild(empty);
  }
  for (const row of rows) {
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "forward-row";
    const snippet = row.msg.file ? T("chat.file.preview." + row.msg.file.kind) : truncate(row.msg.text || "", 60);
    btn.innerHTML = `<div class="avatar avatar-sm" style="background:${avatarGradient(row.contactName)}">${escapeHtml(initials(row.contactName))}</div><span class="forward-name">${escapeHtml(row.contactName)}<br><span class="fine muted">${escapeHtml(snippet)}</span></span>`;
    btn.addEventListener("click", () => {
      const fs = $("#favorites-sheet"); if (fs) fs.classList.add("hidden");
      jumpToMessageInChat(row.contactId, row.msg.id);
    });
    list.appendChild(btn);
  }
  const fs = $("#favorites-sheet"); if (fs) fs.classList.remove("hidden");
}
function jumpToMessageInChat(contactId, msgId) {
  if (typeof resetChatTransientState === "function") resetChatTransientState(contactId);
  state.chatId = contactId;
  state.contactCardId = null;
  state.tab = "chats";
  renderTab();
  requestAnimationFrame(() => {
    ensureMessageRendered(contactId, msgId);
    const wrap = $("#chat-messages");
    const targetEl = wrap && wrap.querySelector(`[data-msg-id="${CSS.escape(msgId)}"]`);
    if (targetEl) {
      targetEl.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
      targetEl.classList.add("highlight-origin");
      setTimeout(() => targetEl.classList.remove("highlight-origin"), 1500);
    }
  });
}
// P2 — мультивыбор сообщений: долгое нажатие → меню → "Выбрать" входит в
// режим, дальнейшие тапы по пузырям переключают выбор вместо обычного
// действия. Шапка (#multiselect-banner) показывает счётчик и действия
// над выбранными разом (удалить у себя / переслать).
function enterMultiSelect(firstMsgId) {
  state.multiSelect = new Set([firstMsgId]);
  renderChatThreadInner();
}
function exitMultiSelect() {
  state.multiSelect = null;
  renderChatThreadInner();
}
function toggleMultiSelectMsg(msgId) {
  if (!state.multiSelect) return;
  if (state.multiSelect.has(msgId)) state.multiSelect.delete(msgId); else state.multiSelect.add(msgId);
  if (state.multiSelect.size === 0) { exitMultiSelect(); return; }
  renderChatThreadInner();
}
function updateMultiSelectBanner() {
  const banner = $("#multiselect-banner");
  if (!banner) return;
  const active = !!state.multiSelect;
  banner.classList.toggle("hidden", !active);
  if (active) { const countEl = $("#multiselect-count"); if (countEl) countEl.textContent = String(state.multiSelect.size); }
}
// P2 — закреплённое сообщение чата (в отличие от уже реализованного
// закрепления ЧАТА в списке — chats.pin). Одно закреплённое сообщение на
// чат, показывается плашкой над лентой; тап по плашке прокручивает к
// оригиналу.
function togglePinnedMessage(contactId, msgId) {
  const c = state.contacts.get(contactId); if (!c) return;
  c.pinnedMessageId = c.pinnedMessageId === msgId ? null : msgId;
  persistContacts();
  if (state.chatId === contactId) renderChatThread();
}
// Вынесена из handleMessageAction("retry", ...) в отдельную функцию —
// нужна и для одиночного повтора из меню сообщения, и для кнопки
// "Повторить всё" в шапке чата (P1.15), которая обходит все failed
// сообщения разом.
async function retryMessage(contactId, msgId) {
  const c = state.contacts.get(contactId); if (!c) return;
  const m = c.messages.find((x) => x.id === msgId); if (!m) return;
  m.serverAcked = false;
  m.ack = "sent";
  if (outbox.has(msgId)) outbox.delete(msgId);

  // Файл/голосовое: собираем Blob из IndexedDB и формируем полный
  // file-payload (тот же формат, что в sendFileOffline/sendVoiceOffline).
  // Пустой text тут не годится — собеседник получил бы пустышку.
  if (m.file) {
    try {
      const blob = await IDB.get("file:" + msgId);
      if (!blob) {
        toast(T("chat.file.unavailable"));
        m.ack = "failed"; persistContacts();
        if (state.chatId === contactId) renderChatThread();
        return;
      }
      const buffer = await blob.arrayBuffer();
      const payload = {
        kind: "file", id: msgId,
        name: m.file.name || "file",
        mime: m.file.mime || "application/octet-stream",
        size: (Number.isFinite(m.file.size) && m.file.size > 0) ? m.file.size : blob.size,
        dataB64: arrayBufferToBase64(buffer),
      };
      if (m.file.duration != null) payload.duration = m.file.duration;
      if (m.file.wave) payload.wave = m.file.wave;
    if (m.file.wave) payload.wave = m.file.wave;
      if (m.file.caption) payload.caption = m.file.caption;
      await retrySend(c, msgId, payload);
    } catch (e) {
      etherLog("error", "[retry] file failed:", String(e));
      m.ack = "failed"; persistContacts();
      if (state.chatId === contactId) renderChatThread();
    }
    return;
  }

  if (m.sticker && window.EtherStickers) { EtherStickers.retry(c, m); return; }
  // Карточка контакта: повторяем как contact-card, не текстом.
  if (m.contactCard) {
    const payload = {
      kind: "contact-card", id: msgId, ts: m.ts,
      contactId: m.contactCard.id,
      contactName: m.contactCard.name || "",
    };
    retrySend(c, msgId, payload);
    return;
  }

  // Обычный текст.
  const payload = { kind: "chat", id: msgId, text: m.text, ts: m.ts };
  if (m.replyTo) payload.replyTo = { id: m.replyTo.id, text: m.replyTo.text, authorName: m.replyTo.authorName };
  if (m.ttl) payload.ttl = m.ttl;
  if (m.forwarded) { payload.forwarded = true; if (m.forwardedFrom) payload.fwdFrom = m.forwardedFrom; }
  retrySend(c, msgId, payload);
}
// Повторная отправка: в личный чат — как раньше; в группу — заново каждому участнику (у группы нет ни ключа, ни канала: прежний вызов
// клал сообщение в очередь «ждём ключ» на id группы навсегда и снова помечал его неотправленным).
async function retrySend(c, msgId, payload) {
  if (!isGroup(c)) return trySendOrQueue(c, msgId, payload);
  payload.groupId = c.id; payload.senderName = Store.name || T("sys.someone");
  for (const mem of c.members) {
    if (mem.id === Store.myId) continue;
    const mc = ensureContactEntry(mem.id, mem.name);
    const deliveryId = crypto.randomUUID();
    groupDeliveryMap.set(deliveryId, { groupId: c.id, contentId: msgId, to: mem.id });
    trimMap(groupDeliveryMap, GROUP_DELIVERY_MAP_LIMIT);
    persistGroupDeliveryMap();
    await trySendOrQueue(mc, deliveryId, payload);
  }
}
// P1.15 — обходит все failed-сообщения "от меня" в чате и повторяет
// каждое. Отправляются не параллельно, а последовательно (await в
// цикле) — иначе N одновременных retry одного и того же канала наперегонки
// друг с другом ничего хорошего не даёт, а trySendOrQueue и так не
// бесплатен (шифрование на сообщение).
async function retryAllFailed(contactId) {
  const c = state.contacts.get(contactId); if (!c) return;
  const failedIds = c.messages.filter((m) => m.from === "me" && m.ack === "failed").map((m) => m.id);
  for (const id of failedIds) { try { await retryMessage(contactId, id); } catch (e) {} }
}
function startEditing(msgId) {
  const c = state.contacts.get(state.chatId); if (!c) return;
  const m = c.messages.find((x) => x.id === msgId); if (!m || m.from !== "me") return;
  state.editingMessageId = msgId;
  const banner = $("#edit-banner"); if (banner) banner.classList.remove("hidden");
  const inp = $("#chat-input");
  if (inp) { inp.value = m.text; inp.focus(); try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch (e) {} }
}
function cancelEditing() { state.editingMessageId = null; const b = $("#edit-banner"); if (b) b.classList.add("hidden"); }
function showReplyBanner() {
  const b = $("#reply-banner"); if (!b) return;
  if (!state.replyTo) { b.classList.add("hidden"); return; }
  b.classList.remove("hidden");
  const a = b.querySelector(".reply-banner-author"); if (a) a.textContent = state.replyTo.authorName;
  const t = b.querySelector(".reply-banner-text"); if (t) t.textContent = truncate(state.replyTo.text, 60);
}
function cancelReply() { state.replyTo = null; const b = $("#reply-banner"); if (b) b.classList.add("hidden"); }
function openForwardSheet(onPick, titleKey) {
  const list = $("#forward-list"); if (!list) return;
  list.innerHTML = "";
  // Пересылать можно и в группы (где разрешено писать) — раньше список содержал только личные чаты
  const contacts = Array.from(state.contacts.values()).filter((c) => c.managed && (!isGroup(c) || isGroupWriteAllowed(c, Store.myId)));
  for (const c of contacts) {
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "forward-row";
    btn.innerHTML = `<div class="avatar avatar-sm" style="background:${avatarGradient(c.name)}">${escapeHtml(initials(c.name))}</div><span class="forward-name">${escapeHtml(c.name || T("sys.someone"))}</span>`;
    btn.addEventListener("click", async () => { const fs = $("#forward-sheet"); if (fs) fs.classList.add("hidden"); await onPick(c.id); });
    list.appendChild(btn);
  }
  const fs = $("#forward-sheet"); if (fs) fs.classList.remove("hidden");
  // killer-features-backlog 0.4 (Share Target) переиспользует этот же лист
  // контактов с другим заголовком, вместо отдельной шторки — заголовок
  // возвращаем обратно к "Forward" через data-i18n, поэтому следующий
  // обычный вызов (без titleKey) снова покажет правильный текст сам.
  const titleEl = fs ? fs.querySelector("h2") : null;
  if (titleEl) {
    const key = titleKey || "chat.forward";
    titleEl.setAttribute("data-i18n", key);
    titleEl.textContent = T(key);
  }
}
// P1.14 — что именно сейчас застряло в очереди отправки и почему: две
// разные причины, два разных источника данных. outbox — сообщение ушло
// на сервер-посредник, но ещё нет deliver-ack (сервер его не подтвердил:
// контакт пока не в сети или сам сервер недоступен). pendingNoKey —
// сообщение вообще не могло быть зашифровано, потому что публичный ключ
// собеседника ещё не получен (ждём его следующего выхода на связь).
function renderOutboxSheet() {
  const list = $("#outbox-list"), empty = $("#outbox-empty");
  if (!list) return;
  list.innerHTML = "";
  const rows = [];
  for (const entry of outbox.values()) {
    const c = state.contacts.get(entry.to);
    rows.push({ contactId: entry.to, name: c ? (c.name || T("sys.someone")) : T("sys.someone"), sentAt: entry.sentAt, reasonKey: "outbox.reason.offline" });
  }
  for (const [contactId, items] of pendingNoKey) {
    if (!items || items.length === 0) continue;
    const c = state.contacts.get(contactId);
    rows.push({ contactId, name: c ? (c.name || T("sys.someone")) : T("sys.someone"), sentAt: null, reasonKey: "outbox.reason.noKey", count: items.length });
  }
  rows.sort((a, b) => (b.sentAt || 0) - (a.sentAt || 0));
  if (empty) empty.classList.toggle("hidden", rows.length > 0);
  for (const row of rows) {
    const el = document.createElement("div");
    el.className = "outbox-row";
    const timeLabel = row.sentAt ? formatChatListTime(row.sentAt) : "";
    const countLabel = row.count ? ` (${row.count})` : "";
    el.innerHTML = `
      <div class="avatar avatar-sm" style="background:${avatarGradient(row.name)}">${escapeHtml(initials(row.name))}</div>
      <div class="outbox-row-body">
        <span class="outbox-row-name">${escapeHtml(row.name)}${countLabel}</span>
        <span class="outbox-row-meta">${escapeHtml(T(row.reasonKey))}${timeLabel ? " · " + escapeHtml(timeLabel) : ""}</span>
      </div>`;
    list.appendChild(el);
  }
}
function openOutboxSheet() {
  renderOutboxSheet();
  const sheet = $("#outbox-sheet"); if (sheet) sheet.classList.remove("hidden");
}
// P2 — "Прыжок к дате": открывает <input type="date"> в шите, затем
// скроллит к первому сообщению того дня. contactId запоминается на
// шите (data-attribute), потому что к моменту нажатия "Go" пользователь
// теоретически мог успеть закрыть чат (в теории, не на практике — шит
// модальный, но дешевле перестраховаться, чем гадать).
function openJumpToDateSheet(contactId) {
  if (!contactId) return;
  const sheet = $("#jump-date-sheet"); if (!sheet) return;
  sheet.dataset.contactId = contactId;
  const input = $("#jump-date-input");
  if (input) { try { input.valueAsDate = new Date(); } catch (e) {} }
  sheet.classList.remove("hidden");
}
// Долгое нажатие (500мс, тот же тайминг, что и у long-press на пузыре
// сообщения) с отменой при уходе пальца/курсора дальше 8px — сетка эмодзи
// находится внутри скроллящейся шторки, так что наивный таймер без
// отмены на движение ложно срабатывал бы при обычном скролле пальцем.
// Pointer Events — тот же механизм, что уже используется для drag-to-
// reorder закреплённых чатов (V.44.0.0), работает одинаково для мыши
// и тач-экрана без дублирования обработчиков.
function wireHandshakeLongPress(btn, onFire) {
  let timer = null, startX = 0, startY = 0, moved = false;
  const clear = () => { clearTimeout(timer); timer = null; };
  btn.addEventListener("pointerdown", (e) => {
    moved = false;
    startX = e.clientX; startY = e.clientY;
    clear();
    timer = setTimeout(() => { if (!moved) onFire(); }, 500);
  });
  btn.addEventListener("pointermove", (e) => {
    if (!timer) return;
    if (Math.abs(e.clientX - startX) > 8 || Math.abs(e.clientY - startY) > 8) { moved = true; clear(); }
  });
  btn.addEventListener("pointerup", clear);
  btn.addEventListener("pointercancel", clear);
}
let __emojiTab = "smileys";      // id категории или "recent"
let __emojiPickHandler = null;   // кто получает выбранный эмодзи: композер (по умолчанию) или реакция на сообщение
let __emojiCloseOnPick = false;
const RECENT_EMOJI_MAX = 32;
function recentEmojiList() {
  try { const a = JSON.parse(Store.recentEmojiJson); return Array.isArray(a) ? a.filter((x) => typeof x === "string") : []; } catch (e) { return []; }
}
function recordRecentEmoji(base) {
  const cur = recentEmojiList().filter((e) => e !== base);
  cur.unshift(base);
  try { Store.recentEmojiJson = JSON.stringify(cur.slice(0, RECENT_EMOJI_MAX)); } catch (e) {}
}
function emojiTabSource(tab) {
  if (tab === "recent") return recentEmojiList();
  const cat = EMOJI_CATEGORIES.find((x) => x.id === tab);
  return cat ? cat.emojis : [];
}
function pickEmoji(base, rendered) {
  recordRecentEmoji(base);
  const h = __emojiPickHandler;
  if (h) h(rendered, base); else insertEmojiAtCursor(rendered);
  if (__emojiCloseOnPick) { const sh = $("#emoji-picker-sheet"); if (sh) sh.classList.add("hidden"); }
}
function renderEmojiGrid(emojis) {
  const grid = $("#emoji-grid"); if (!grid) return;
  setTimeout(() => { try { updateEmojiToneButton(); } catch (e) {} }, 0);
  const search = $("#emoji-search-input");
  const searching = !!(search && search.value.trim());
  const title = $("#emoji-section-title");
  if (title) title.textContent = searching ? T("emoji.search.results") : T("emoji.cat." + __emojiTab);
  grid.innerHTML = "";
  if (!emojis.length) {
    const p = document.createElement("p"); p.className = "muted emoji-empty"; p.textContent = T(searching ? "emoji.search.none" : "emoji.recent.empty");
    grid.appendChild(p); return;
  }
  for (const e of emojis) {
    // Тон кожи применяется и к отображению, и к вставляемому символу (превью в сетке = то, что получит собеседник);
    // базовый «e» остаётся ключом для поиска и для списка недавних.
    const rendered = applySkinTone(e);
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "emoji-grid-btn"; btn.textContent = rendered;
    if (e === "🤝") {
      // Обычный tap — единый текущий тон; долгое нажатие — шторка выбора ДВУХ разных тонов (buildHandshakeEmoji)
      let longPressFired = false;
      wireHandshakeLongPress(btn, () => { longPressFired = true; openHandshakeToneSheet(); });
      btn.addEventListener("click", () => {
        if (longPressFired) { longPressFired = false; return; }
        pickEmoji(e, rendered);
      });
    } else {
      btn.addEventListener("click", () => pickEmoji(e, rendered));
    }
    grid.appendChild(btn);
  }
}
// Выбор тона кожи: кнопка с рукой справа от поиска раскрывает строку из 6 свотчей; выбор применяется ко всем категориям
// (ко всем эмодзи, которые тон допускают) и сворачивает строку. onChange перерисовывает текущий режим (категория или поиск).
function updateEmojiToneButton() {
  const b = $("#emoji-tone-btn"); if (!b) return;
  b.textContent = applySkinTone("👋");
  // Тон кожи бывает только у эмодзи с людьми и жестами (руки, лица-люди). В «Смайликах», «Еде», «Символах» и т.д. таких нет —
  // кнопку показываем только там, где она реально что-то меняет, чтобы не создавать впечатление «сломанного» переключателя.
  let any = true;
  try { const src = currentEmojiGridSource(); any = Array.isArray(src) ? src.some((e) => emojiSupportsSkinTone(typeof e === "string" ? e : (e && e.e) || "")) : true; } catch (e) {}
  b.classList.toggle("hidden", !any);
  if (!any) { const row = $("#emoji-skin-tone-row"); if (row) row.classList.add("hidden"); b.setAttribute("aria-expanded", "false"); }
}
function renderSkinToneRow(onChange) {
  const row = $("#emoji-skin-tone-row"); if (!row) return;
  row.innerHTML = "";
  const current = Store.emojiSkinTone;
  for (const tone of SKIN_TONE_MODIFIERS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "skin-tone-swatch" + (tone.id === current ? " active" : "");
    btn.style.background = tone.swatch;
    btn.setAttribute("aria-label", T("chat.emoji.skinTone." + tone.id));
    btn.addEventListener("click", () => {
      Store.emojiSkinTone = tone.id;
      renderSkinToneRow(onChange);
      updateEmojiToneButton();
      row.classList.add("hidden");
      const tb = $("#emoji-tone-btn"); if (tb) tb.setAttribute("aria-expanded", "false");
      onChange();
    });
    row.appendChild(btn);
  }
}
// Раздел 11 роадмапа — двусторонний skin-tone для 🤝. Общая функция для
// обеих рук (параметр which: "a"/"b") — ровно тот же паттерн свотчей, что
// и renderSkinToneRow(), только пишет в локальное состояние шторки
// (__handshakeToneA/B), а не в Store, потому что это одноразовый выбор
// для конкретной вставки эмодзи, а не постоянная глобальная настройка.
let __handshakeToneA = "none";
let __handshakeToneB = "none";
function renderHandshakeToneRow(which) {
  const row = $("#handshake-tone-row-" + which); if (!row) return;
  row.innerHTML = "";
  const current = which === "a" ? __handshakeToneA : __handshakeToneB;
  for (const tone of SKIN_TONE_MODIFIERS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "skin-tone-swatch" + (tone.id === current ? " active" : "");
    btn.style.background = tone.swatch;
    btn.setAttribute("aria-label", T("chat.emoji.skinTone." + tone.id));
    btn.addEventListener("click", () => {
      if (which === "a") __handshakeToneA = tone.id; else __handshakeToneB = tone.id;
      renderHandshakeToneRow(which);
      updateHandshakeTonePreview();
    });
    row.appendChild(btn);
  }
}
function updateHandshakeTonePreview() {
  const prev = $("#handshake-tone-preview"); if (prev) prev.textContent = buildHandshakeEmoji(__handshakeToneA, __handshakeToneB);
}
// Открывается долгим нажатием на 🤝 в сетке (см. renderEmojiGrid). Каждая
// рука по умолчанию стартует с уже выбранного общего тона (Store.emojiSkinTone)
// — большинству пользователей, скорее всего, нужен всего один "неодинаковый"
// случай, а не обе руки с нуля на "none" при каждом открытии.
function openHandshakeToneSheet() {
  __handshakeToneA = Store.emojiSkinTone;
  __handshakeToneB = Store.emojiSkinTone;
  renderHandshakeToneRow("a");
  renderHandshakeToneRow("b");
  updateHandshakeTonePreview();
  const sheet = $("#handshake-tone-sheet"); if (sheet) sheet.classList.remove("hidden");
}
let __handshakeToneSheetWired = false;
function wireHandshakeToneSheet() {
  if (__handshakeToneSheetWired) return;
  __handshakeToneSheetWired = true;
  const sheet = $("#handshake-tone-sheet"); if (!sheet) return;
  const insertBtn = $("#handshake-tone-insert");
  if (insertBtn) insertBtn.addEventListener("click", () => {
    pickEmoji("🤝", buildHandshakeEmoji(__handshakeToneA, __handshakeToneB));
    sheet.classList.add("hidden");
  });
}
function renderEmojiTabs() {
  const tabs = $("#emoji-tabs"); if (!tabs) return;
  tabs.innerHTML = "";
  const list = [{ id: "recent", icon: "🕘" }].concat(EMOJI_CATEGORIES);
  for (const cat of list) {
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "emoji-tab-btn" + (cat.id === __emojiTab ? " active" : "");
    btn.textContent = cat.icon;
    btn.setAttribute("role", "tab"); btn.setAttribute("aria-selected", cat.id === __emojiTab ? "true" : "false");
    btn.setAttribute("aria-label", T("emoji.cat." + cat.id));
    btn.addEventListener("click", () => {
      __emojiTab = cat.id;
      const search = $("#emoji-search-input"); if (search) search.value = "";
      renderEmojiTabs();
      renderEmojiGrid(emojiTabSource(cat.id));
      const grid = $("#emoji-grid"); if (grid) grid.scrollTop = 0;
    });
    tabs.appendChild(btn);
  }
}
// Вставляет эмодзи в позицию курсора (а не всегда в конец — пользователь
// может редактировать середину текста) и держит фокус в поле ввода,
// чтобы можно было вставить несколько эмодзи подряд без лишних тапов.
// @упоминания в группах — автодополнение имени участника при вводе "@".
// Находим незакрытый токен "@partial" от последнего "@" до каретки (без
// пробелов внутри), ищем совпадающих по префиксу участников группы.
function currentMentionToken(input) {
  const pos = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, pos);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  const token = before.slice(at + 1);
  if (/\s/.test(token)) return null; // пробел закрывает токен
  return { start: at, end: pos, partial: token };
}
function updateMentionAutocomplete() {
  const input = $("#chat-input");
  const box = $("#mention-autocomplete");
  if (!input || !box) return;
  const c = state.chatId ? state.contacts.get(state.chatId) : null;
  if (!c || !isGroup(c)) { closeMentionAutocomplete(); return; }
  const tok = currentMentionToken(input);
  if (!tok) { closeMentionAutocomplete(); return; }
  const q = tok.partial.toLowerCase();
  const candidates = c.members.filter((m) => m.id !== Store.myId && (m.name || "").toLowerCase().startsWith(q));
  if (candidates.length === 0) { closeMentionAutocomplete(); return; }
  box.innerHTML = candidates.slice(0, 6).map((m) => `<button type="button" class="mention-autocomplete-item" data-member-id="${escapeHtml(m.id)}" data-member-name="${escapeHtml(m.name || "")}">${escapeHtml(m.name || T("sys.someone"))}</button>`).join("");
  box.classList.remove("hidden");
  state._mentionTokenRange = { start: tok.start, end: tok.end };
}
function closeMentionAutocomplete() {
  const box = $("#mention-autocomplete");
  if (box) { box.classList.add("hidden"); box.innerHTML = ""; }
  state._mentionTokenRange = null;
}
function applyMentionChoice(name) {
  const input = $("#chat-input");
  const range = state._mentionTokenRange;
  if (!input || !range) return;
  const insert = name + " ";
  input.value = input.value.slice(0, range.start) + "@" + insert + input.value.slice(range.end);
  const newPos = range.start + 1 + insert.length;
  closeMentionAutocomplete();
  input.focus();
  input.setSelectionRange(newPos, newPos);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
function wireMentionAutocomplete() {
  const box = $("#mention-autocomplete");
  if (!box) return;
  box.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".mention-autocomplete-item");
    if (!btn) return;
    applyMentionChoice(btn.dataset.memberName || "");
  });
}
function insertEmojiAtCursor(emoji) {
  const input = $("#chat-input"); if (!input) return;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
  const newPos = start + emoji.length;
  input.setSelectionRange(newPos, newPos);
  // пока открыта панель эмодзи, клавиатуру не поднимаем
  const pk = $("#emoji-picker-sheet");
  if (!pk || pk.classList.contains("hidden")) input.focus();
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
// Общая точка для "что сейчас должно быть в сетке" — используется и
// обработчиком поиска, и колбэком выбора тона кожи (renderSkinToneRow),
// чтобы смена тона перерисовывала ТЕКУЩИЙ режим пикера (активная категория
// или текущие результаты поиска), а не всегда сбрасывала на категорию.
function currentEmojiGridSource() {
  const search = $("#emoji-search-input");
  const q = search ? search.value : "";
  const results = emojiSearchResults(q);
  return results === null ? emojiTabSource(__emojiTab) : results;
}
// Высота композера зависит от того, какие баннеры сейчас видны (ответ,
// редактирование, "отправить позже") и от safe-area-inset-bottom — её
// нельзя захардкодить в CSS один раз, нужно измерять непосредственно
// перед открытием. #app-shell — containing block для .sheet (см.
// `contain: layout` на #app-shell), поэтому отступ считаем от его края,
// а не от окна браузера: на десктопной раскладке (см. @media выше)
// #app-shell — не весь экран, а центрированная «рамка телефона».
function positionEmojiFlyout() {
  const panel = $("#emoji-picker-sheet .sheet-panel");
  const shell = $("#app-shell");
  const form = $("#chat-form");
  if (!panel || !shell || !form) return;
  const shellRect = shell.getBoundingClientRect();
  const formRect = form.getBoundingClientRect();
  const gap = 8;
  const bottomOffset = Math.max(gap, Math.round(shellRect.bottom - formRect.top + gap));
  panel.style.marginBottom = bottomOffset + "px";
}
// Один пикер на всё приложение: из композера (вставка в поле ввода, шторка остаётся открытой) и из реакций на сообщение
// (opts.onPick — выбранный эмодзи уходит в реакцию, шторка закрывается).
function openEmojiPicker(opts) {
  const sheet = $("#emoji-picker-sheet"); if (!sheet) return;
  __emojiPickHandler = (opts && typeof opts.onPick === "function") ? opts.onPick : null;
  __emojiCloseOnPick = !!(opts && opts.closeOnPick);
  const search = $("#emoji-search-input"); if (search) search.value = "";
  if (!EMOJI_CATEGORIES.some((c) => c.id === __emojiTab) && __emojiTab !== "recent") __emojiTab = "smileys";
  if (__emojiTab === "recent" && recentEmojiList().length === 0) __emojiTab = "smileys";
  const tr = $("#emoji-skin-tone-row"); if (tr) tr.classList.add("hidden");
  const tb = $("#emoji-tone-btn"); if (tb) tb.setAttribute("aria-expanded", "false");
  renderEmojiTabs();
  renderSkinToneRow(() => renderEmojiGrid(currentEmojiGridSource()));
  updateEmojiToneButton();
  renderEmojiGrid(emojiTabSource(__emojiTab));
  sheet.classList.remove("hidden");
  positionEmojiFlyout();
  // Фокус в поле поиска открывал бы экранную клавиатуру и сразу прятал половину пикера — ставим его только по нажатию на поиск
}
function wireEmojiPicker() {
  const btn = $("#chat-emoji-btn");
  if (btn) btn.addEventListener("click", () => { if (state.chatId) openEmojiPicker(); });
  const search = $("#emoji-search-input");
  if (search) search.addEventListener("input", () => renderEmojiGrid(currentEmojiGridSource()));
  const toneBtn = $("#emoji-tone-btn");
  if (toneBtn) toneBtn.addEventListener("click", () => {
    const row = $("#emoji-skin-tone-row"); if (!row) return;
    const open = row.classList.contains("hidden");
    row.classList.toggle("hidden", !open);
    toneBtn.setAttribute("aria-expanded", open ? "true" : "false");
  });
}
// Кнопка «+» композера открывает компактное меню-шторку: эмодзи, камера, файл (раньше три кружка «веером» поверх ленты).
// Любое действие, фон, Esc, смена чата и отправка сообщения закрывают меню. Кнопки действий сохранили прежние id —
// обработчики эмодзи-пикера, камеры и выбора файла повешены на них.
function setComposerFan(open) {
  const sheet = $("#composer-menu-sheet"); if (sheet) sheet.classList.toggle("hidden", !open);
  const plus = $("#chat-plus-btn"); if (plus) plus.setAttribute("aria-expanded", open ? "true" : "false");
  if (plus && plus.__menuUnbind) { try { plus.__menuUnbind(); } catch (e) {} plus.__menuUnbind = null; }
  if (sheet && !open) { sheet.classList.remove("menu-expanded"); const mb = $("#composer-menu-more"); if (mb) mb.setAttribute("aria-expanded", "false"); }
  // V.79: общие positionAnchored/bindMenuDismiss — над кнопкой «+», не выходя за экран, под клавиатуру (visualViewport) и в safe-area; RTL учитывается
  if (open && sheet && plus) {
    renderComposerRecent();
    const panel = sheet.querySelector(".sheet-panel");
    const place = () => {
      if (!panel || !plus.getBoundingClientRect().width) return;
      const so = sheet.getBoundingClientRect(), pw = Math.min(320, (window.innerWidth || 360) - 24);
      panel.style.width = pw + "px"; panel.style.bottom = "auto"; panel.style.right = "auto";
      const pos = positionAnchored(panel, plus, { align: "start", side: "up", gap: 10, origin: so });
      panel.style.setProperty("--menu-left", Math.round(pos.left - so.left) + "px");
    };
    place();
    plus.__menuReplace = place;
    plus.__menuUnbind = bindMenuDismiss(sheet, { anchor: plus, itemSel: ".composer-menu-item", close: () => setComposerFan(false) });
    const first = sheet.querySelector(".composer-menu-item:not(.hidden)"); if (first) { try { first.focus({ preventScroll: true }); } catch (e) {} }
  }
}
// «Недавнее»: последнее фото/файл этого чата; тап прокручивает к нему. Нет файлов — ряд скрыт.
function renderComposerRecent() {
  const el = $("#composer-recent"); if (!el) return;
  const c = state.chatId && state.contacts.get(state.chatId);
  let last = null;
  if (c) for (let i = c.messages.length - 1; i >= 0; i--) { const f = c.messages[i].file; if (f && !f.pending && !f.failed) { last = c.messages[i]; break; } }
  if (!last) { el.classList.add("hidden"); el.innerHTML = ""; el.dataset.msgId = ""; return; }
  const fk = last.file.kind, isGif = /\.gif$/i.test(last.file.name || "");
  const icon = fk === "video" ? "video" : fk === "audio" ? "mic" : (fk === "image" || isGif) ? "image" : "paperclip";
  const nm = last.file.name || T("chat.file.preview." + fk);
  el.dataset.msgId = last.id;
  // миниатюра — только если картинка уже в кэше blob-URL (без загрузки из IDB)
  let thumb = ""; try { thumb = fk === "image" && typeof fileBlobUrlCache !== "undefined" ? (fileBlobUrlCache.get(last.id) || "") : ""; } catch (e) {}
  const lead = thumb ? `<img class="cr-thumb" src="${escapeHtml(thumb)}" alt="" width="32" height="32" />` : `<svg class="cr-icon" data-icon="${icon}" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"></svg>`;
  el.innerHTML = `${lead}<span class="cr-text"><span class="cr-cap">${escapeHtml(T("chat.menu.recentLast"))}</span><span class="cr-name">${escapeHtml(nm)}</span></span>`;
  el.setAttribute("aria-label", T("chat.menu.recentLast") + ": " + nm);
  try { if (window.Icons) Icons.hydrate(el); } catch (e) {}
  el.classList.remove("hidden");
}
function collapseComposerPlus() { setComposerFan(false); }
// Переключатели, чьё состояние показано классом (.active/.on), сообщают его и скринридеру: aria-pressed следует за классом.
const ARIA_PRESSED_SEL = ".theme-seg button, #chat-filters .chat-filter-chip, .onboarding-lang-btn, #story-swatches .story-swatch, #call-mute-btn, #call-speaker-btn, #call-video-btn";
function syncAriaPressed(root) {
  try {
    (root || document).querySelectorAll(ARIA_PRESSED_SEL).forEach((b) => {
      if (b.classList.contains("summary-period")) return;
      const on = b.classList.contains("active") || b.classList.contains("on") ? "true" : "false";
      if (b.getAttribute("aria-pressed") !== on) b.setAttribute("aria-pressed", on);
    });
  } catch (e) {}
}
function wireAriaPressedSync() {
  syncAriaPressed();
  if (typeof MutationObserver === "undefined" || !document.body) return;
  let t = null;
  new MutationObserver(() => { if (t) return; t = setTimeout(() => { t = null; syncAriaPressed(); }, 50); })
    .observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"], childList: true });
}
function wireComposerPlusMode() {
  try { wireAriaPressedSync(); } catch (e) {}
  wireChatInputKeys();
  const plusBtn = $("#chat-plus-btn"); if (!plusBtn) return;
  plusBtn.addEventListener("click", (e) => {
    e.preventDefault();
    if (plusBtn.__lpFired) { plusBtn.__lpFired = false; return; }
    const sheet = $("#composer-menu-sheet");
    setComposerFan(!!(sheet && sheet.classList.contains("hidden")));
  });
  // Долгое нажатие на «+» — быстрое действие: камера
  let plusLP = null;
  const plusLPCancel = () => { clearTimeout(plusLP); plusLP = null; };
  plusBtn.addEventListener("pointerdown", () => {
    plusLPCancel(); plusBtn.__lpFired = false;
    plusLP = setTimeout(() => { plusLP = null; plusBtn.__lpFired = true; try { if (navigator.vibrate) navigator.vibrate(12); } catch (e) {} collapseComposerPlus(); const cam = $("#chat-camera-btn"); if (cam && state.chatId) cam.click(); }, 550);
  });
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) plusBtn.addEventListener(ev, plusLPCancel);
  plusBtn.addEventListener("contextmenu", (e) => { if (plusBtn.__lpFired) e.preventDefault(); });
  // V.79: в простом режиме редкие плашки (data-menu-more) скрыты, «Ещё» раскрывает их на месте
  const moreBtn = $("#composer-menu-more");
  if (moreBtn) moreBtn.addEventListener("click", () => {
    const sh = $("#composer-menu-sheet"); if (!sh) return;
    sh.classList.add("menu-expanded"); moreBtn.setAttribute("aria-expanded", "true");
    try { if (plusBtn.__menuReplace) plusBtn.__menuReplace(); } catch (e) {}
    const f = sh.querySelector("[data-menu-more]"); if (f) { try { f.focus({ preventScroll: true }); } catch (e) {} }
  });
  const recent = $("#composer-recent");
  if (recent) recent.addEventListener("click", () => {
    const id = recent.dataset.msgId; collapseComposerPlus();
    if (id && state.chatId) jumpToMessageInChat(state.chatId, id); // прокрутка + подсветка (highlight-origin)
  });
  // Выбор любого из трёх действий закрывает меню (capture — раньше, чем сработают обработчики самих кнопок)
  for (const id of ["#chat-attach-btn", "#chat-emoji-btn", "#chat-camera-btn", "#chat-poll-btn", "#chat-board-btn", "#chat-note-btn", "#chat-summary-btn"]) {
    const btn = $(id);
    if (btn) btn.addEventListener("click", collapseComposerPlus, { capture: true });
  }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") collapseComposerPlus(); });
  // aria-expanded у «+» следует за видимостью шторки, даже если её закрыли по фону или жестом
  const sheet = $("#composer-menu-sheet");
  if (sheet && typeof MutationObserver !== "undefined") {
    new MutationObserver(() => {
      const hid = sheet.classList.contains("hidden");
      plusBtn.setAttribute("aria-expanded", hid ? "false" : "true");
      if (hid && plusBtn.__menuUnbind) { try { plusBtn.__menuUnbind(); } catch (e) {} plusBtn.__menuUnbind = null; sheet.classList.remove("menu-expanded"); }
    }).observe(sheet, { attributes: true, attributeFilter: ["class"] });
  }
  const form = $("#chat-form");
  if (form) form.addEventListener("submit", collapseComposerPlus);
}
function wireJumpToDateSheet() {
  const goBtn = $("#jump-date-go-btn");
  if (!goBtn) return;
  goBtn.addEventListener("click", () => {
    const sheet = $("#jump-date-sheet");
    const input = $("#jump-date-input");
    const contactId = sheet ? sheet.dataset.contactId : null;
    if (sheet) sheet.classList.add("hidden");
    if (!contactId || !input || !input.value) return;
    const target = new Date(input.value + "T00:00:00");
    const c = state.contacts.get(contactId); if (!c) return;
    const match = c.messages.find((m) => {
      const d = new Date(m.ts);
      return d.getFullYear() === target.getFullYear() && d.getMonth() === target.getMonth() && d.getDate() === target.getDate();
    });
    if (!match) { toast(T("toast.noMessagesOnDate")); return; }
    if (state.chatId !== contactId) { if (typeof resetChatTransientState === "function") resetChatTransientState(contactId); state.chatId = contactId; renderTab(); }
    // renderChatThread уже отрисовала DOM синхронно выше — ищем элемент
    // сообщения по data-msg-id, который проставляется в разметке пузыря.
    setTimeout(() => {
      ensureMessageRendered(contactId, match.id);
      const el = document.querySelector(`#chat-messages [data-msg-id="${CSS.escape(match.id)}"]`);
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "auto" });
        el.classList.add("jump-highlight");
        setTimeout(() => el.classList.remove("jump-highlight"), 1500);
      }
    }, 50);
  });
}
function wireRenameSheet() {
  const btn = $("#rename-save-btn"); if (!btn) return;
  btn.addEventListener("click", () => {
    const id = state.activeContactContext;
    const ri = $("#rename-input"); if (!ri) return;
    const v = ri.value.trim();
    if (!id || !v) return;
    const c = state.contacts.get(id); if (!c) return;
    c.name = v.slice(0, 40); c.nameLocal = true;
    persistContacts();
    const rs = $("#rename-sheet"); if (rs) rs.classList.add("hidden");
    if (state.chatId === id) renderChatThread();
    if (state.contactCardId === id) renderContactCard();
    renderChatsList();
    toast(T("toast.nameUpdated"));
  });
}
// Общая логика "снести всё и перезапуститься с чистого листа" — раньше
// была только в debug-hard-reset-btn; вынесена сюда, чтобы «Удалить
// аккаунт» в обычных настройках делала ровно то же самое, без
// расхождения поведения между скрытой Debug-кнопкой и видимой.
// Полное стирание данных устройства. Раньше все сбросы чистили только localStorage (резервная копия в IndexedDB оставалась и при загрузке
// возвращала PIN, ключи и переписку), а перезагрузка запускала beforeunload, который тут же записывал данные обратно.
async function wipeEverythingAndReload() {
  __wiping = true;
  // push-подписка и сервис-воркер: иначе сервер продолжит слать пуши на уже стёртое устройство
  try {
    if ("serviceWorker" in navigator) {
      const reg = await Promise.race([navigator.serviceWorker.getRegistration(), new Promise((r) => setTimeout(() => r(null), 1500))]);
      if (reg) {
        try { const sub = reg.pushManager && await reg.pushManager.getSubscription(); if (sub) await sub.unsubscribe(); } catch (e) {}
        try { await reg.unregister(); } catch (e) {}
      }
    }
  } catch (e) {}
  try { localStorage.clear(); } catch (e) {}
  try { const noop = function () {}; Storage.prototype.setItem = noop; } catch (e) {} // с этого момента ничто не пишет в хранилище
  const tasks = [];
  try { await IDB.close(); } catch (e) {}
  if ("caches" in window) tasks.push(caches.keys().then((names) => Promise.all(names.map((n) => caches.delete(n)))).catch(() => {}));
  if ("indexedDB" in window) tasks.push(new Promise((res) => { try { const r = indexedDB.deleteDatabase("ether-db"); r.onsuccess = r.onerror = r.onblocked = () => res(); } catch (e) { res(); } setTimeout(res, 3000); }));
  await Promise.all(tasks);
  try { localStorage.clear(); } catch (e) {}
  location.reload();
}
function performFullAccountWipe() { return wipeEverythingAndReload(); }
function deleteContact(id) {
  // Карточка контакта сегодня никогда не открывает эту функцию для
  // группы (openContactCard редиректит в openGroupInfo) — но функция
  // остаётся вызываемой напрямую (консоль, будущий код), и без этой
  // проверки она удалила бы группу молча ЛОКАЛЬНО: mesh.remove(groupId)
  // — no-op (у группы нет своего линка), state.contacts.delete(groupId)
  // убирает её у меня, но остальные участники ничего не узнают и
  // продолжат считать меня в группе. removeGroupMember(.., Store.myId,
  // true) — тот же путь, что и обычный "Выйти из группы": оповещает
  // оставшихся через broadcastGroupRoster ДО удаления.
  const cg = state.contacts.get(id);
  if (isGroup(cg)) { removeGroupMember(id, Store.myId, true); return; }
  if (cg && cg.isSelf && !cg.isDemo) { toast(T("toast.cantDeleteSelfChat")); return; }
  // Если удаляют контакт прямо во время звонка с ним — раньше это
  // полагалось на побочный эффект mesh.remove() ниже, а не на настоящий
  // closeCallScreen(). pendingRemoteStreams и другая очистка (audio-
  // элемент, таймеры) живут именно в closeCallScreen — вызываем его
  // явно и первым, до разрыва mesh-связи.
  if (state.callId === id) closeCallScreen("failed");
  clearAutoConnectTimer(id);
  mesh.remove(id);
  const c0 = state.contacts.get(id);
  if (c0) cleanupExpiredFileBlobs(c0.messages);
  pendingNoKey.delete(id); persistPendingNoKey();
  { let gdChanged = false;
    for (const [dId, e] of groupDeliveryMap) if (e.to === id) { groupDeliveryMap.delete(dId); gdChanged = true; }
    if (gdChanged) persistGroupDeliveryMap(); }
  for (const [msgId, entry] of outbox) if (entry.to === id) outbox.delete(msgId);
  persistOutbox();
  delete state.lastSeen[id]; persistLastSeen();
  delete state.drafts[id]; persistDrafts();
  if (state.scheduledMessages.some((s) => s.contactId === id)) {
    state.scheduledMessages = state.scheduledMessages.filter((s) => s.contactId !== id);
    persistScheduledMessages();
  }
  if (state.folders.some((f) => f.contactIds.includes(id))) {
    for (const f of state.folders) f.contactIds = f.contactIds.filter((cid) => cid !== id);
    persistChatFolders();
    renderChatFolderChips();
  }
  unreadDividerFor.delete(id);
  dividerScrolledFor.delete(id);
  relayAttemptCooldown.delete(id);
  // До 200 непримененных ICE-кандидатов на контакт (см. лимит в
  // handleIncomingOffer) иначе остаются в памяти до перезагрузки —
  // этот контакт уже удалён, они больше никогда не будут востребованы.
  pendingIceCandidates.delete(id);
  if (state.activeContactContext === id) state.activeContactContext = null;
  state.mentionedChats.delete(id); // на прямые контакты не вешается, но безопасно и симметрично остальной чистке
  const audioEl = document.getElementById("remote-audio-" + id); if (audioEl) audioEl.remove();
  state.contacts.delete(id);
  try { Ratchet.reset(id); } catch (e) {}
  recentlyDeletedIds.set(id, Date.now());
  // .keys().next().value — самый старый id по порядку вставки (Map, как и
  // Set, сохраняет порядок вставки); .values() здесь дал бы timestamp, а не
  // id, раз recentlyDeletedIds стал Map<id, ts>.
  if (recentlyDeletedIds.size > 500) recentlyDeletedIds.delete(recentlyDeletedIds.keys().next().value);
  persistRecentlyDeleted();
  persistContacts();
  // Раньше здесь была повторная проверка if (state.callId === id)
  // closeCallScreen() — мёртвый код: closeCallScreen("failed") уже
  // вызван выше (строка с комментарием про pendingRemoteStreams/аудио) и
  // безусловно обнуляет state.callId внутри себя, так что к этому месту
  // state.callId уже не может быть равен id.
  if (state.chatId === id) { state.chatId = null; __lastRenderedChatId = null; state.multiSelect = null; }
  if (state.contactCardId === id) state.contactCardId = null;
  renderTab();
  toast(T("toast.contactDeleted"));
}
function exportChat(contactId) {
  const c = state.contacts.get(contactId); if (!c) return;
  const lines = c.messages.map((m) => {
    const date = new Date(m.ts).toLocaleString(I18N.current);
    if (m.from === "system") {
      let st = m.text || "";
      try { if (m.textKey && typeof renderSystemMessageText === "function") st = renderSystemMessageText(m) || st; } catch (e) {}
      return `[${date}] * ${st}`;
    }
    const who = m.from === "me" ? (Store.name || "") : (m.fromName || c.name || "");
    const react = m.reactions ? " " + Object.keys(m.reactions).join("") : "";
    let body = m.text || "";
    if (m.file) body = T("chat.file.preview." + m.file.kind) + (m.file.caption ? ": " + m.file.caption : "");
    else if (m.poll) body = T("chat.poll.preview", { q: m.text });
    else if (m.board) body = T("chat.board.preview", { title: m.text });
    else if (m.note) body = T("chat.note.preview", { title: m.text });
    else if (m.contactCard) body = T("chat.contactCard.preview", { name: m.contactCard.name || T("sys.someone") });
    return `[${date}] ${who}: ${body}${react}`;
  });
  const text = (c.name || "") + "\n\n" + lines.join("\n");
  downloadBlob(new Blob([text], { type: "text/plain;charset=utf-8" }), `ether-${contactId.slice(0, 8)}-${Date.now()}.txt`);
  toast(T("toast.exportDone"));
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

