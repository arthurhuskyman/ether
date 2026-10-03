// Групповые чаты реализованы как веерная рассылка через уже
// существующую 1-к-1 инфраструктуру (полносвязная mesh, до 10
// участников — см. README). Полноценный DOM-тест всего app.js
// непрактичен (слишком много зависимостей от браузерного окружения),
// поэтому здесь — сфокусированные тесты именно той логики, которая
// реально может сломаться незаметно: (1) обход существующего
// ограничения outbox (ключуется только по msgId, без получателя) и
// (2) маршрутизация входящих сообщений в группу вместо личных сообщений
// отправителя.

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log("  OK   " + label); }
  else { fail++; console.log("  FAIL " + label); }
}

console.log("\n=== Обход бага outbox: msgId без получателя ===");
{
  const outbox = new Map();
  function addToOutbox(msgId, to, payload) {
    if (outbox.has(msgId)) return; // подтверждённое поведение существующего кода
    outbox.set(msgId, { msgId, to, payload });
  }

  // Подтверждаем сам баг с общим id
  const sharedId = "shared-id";
  for (const r of ["alice", "bob", "carol"]) addToOutbox(sharedId, r, { text: "hi" });
  check("баг подтверждён: с общим msgId в outbox остаётся только первый получатель", outbox.size === 1);

  // Проверяем реальный подход sendGroupMessage — свой id на каждого
  outbox.clear();
  const usedIds = new Set();
  for (const r of ["alice", "bob", "carol"]) {
    const deliveryId = "uuid-" + Math.random().toString(36).slice(2);
    usedIds.add(deliveryId);
    addToOutbox(deliveryId, r, { kind: "chat", groupId: "g1", text: "hi" });
  }
  check("все 3 получателя попали в outbox отдельными записями", outbox.size === 3);
  check("каждая запись указывает на правильного получателя", Array.from(outbox.values()).map((e) => e.to).sort().join(",") === "alice,bob,carol");
  check("id доставки все уникальны", usedIds.size === 3);
  check("общий groupId сохранился во всех копиях (для дедупликации у получателя)", Array.from(outbox.values()).every((e) => e.payload.groupId === "g1"));
}

console.log("\n=== Маршрутизация входящих: 1-к-1 vs группа, дедупликация ===");
{
  const contacts = new Map();
  contacts.set("alice", { id: "alice", name: "Алиса", messages: [] });
  contacts.set("g1", { id: "g1", isGroup: true, name: "Тестовая группа", messages: [] });

  function routeIncomingChat(from, payload) {
    const groupId = payload.groupId;
    const c = groupId ? contacts.get(groupId) : contacts.get(from);
    if (!c) return "no-target";
    if (c.messages.some((m) => m.id === payload.id)) return "dedup-skip";
    const rec = { id: payload.id, from: "them", text: payload.text };
    if (groupId) { rec.fromId = from; rec.fromName = payload.senderName; }
    c.messages.push(rec);
    return "added";
  }

  check("обычное 1-к-1 сообщение идёт в личку отправителя", routeIncomingChat("alice", { id: "m1", text: "hi" }) === "added" && contacts.get("alice").messages.some((m) => m.id === "m1"));

  const r2 = routeIncomingChat("alice", { id: "m2", text: "hi group", groupId: "g1", senderName: "Алиса" });
  check("групповое сообщение маршрутизируется в группу", r2 === "added" && contacts.get("g1").messages.some((m) => m.id === "m2"));
  check("групповое сообщение НЕ попадает в личку отправителя", !contacts.get("alice").messages.some((m) => m.id === "m2"));
  check("настоящий отправитель (fromId) сохранён для отображения имени", contacts.get("g1").messages.find((m) => m.id === "m2").fromId === "alice");

  const before = contacts.get("g1").messages.length;
  check("повторная доставка того же группового сообщения не дублируется", routeIncomingChat("alice", { id: "m2", text: "hi group", groupId: "g1" }) === "dedup-skip" && contacts.get("g1").messages.length === before);

  check("сообщение в неизвестную группу тихо игнорируется, не падает", routeIncomingChat("bob", { id: "m3", text: "hi", groupId: "unknown" }) === "no-target");
}

console.log("\n=== groupDeliveryMap: ack группового сообщения находится даже после удаления outbox-записи ===");
{
  // Миниатюрная копия реальной логики markMessageAck из js/app.js —
  // воспроизводит именно тот баг, который был найден в ревью
  // ("Ack-квитанции для групповых сообщений через сервер теряются"):
  // deliver-ack с сервера удаляет outbox-запись почти сразу после
  // отправки, а настоящая квитанция "доставлено"/"прочитано" от
  // получателя может прийти намного позже, когда outbox уже пуст.
  const outbox = new Map();
  const groupDeliveryMap = new Map();
  const contacts = new Map();
  contacts.set("g1", { id: "g1", isGroup: true, messages: [{ id: "content-1", from: "me", ack: "sent" }] });
  contacts.set("bob", { id: "bob", messages: [] }); // 1-к-1 "контакт"-обёртка участника группы

  function resolveGroupDelivery(deliveryId) {
    const entry = groupDeliveryMap.get(deliveryId);
    if (!entry) return null;
    const g = contacts.get(entry.groupId);
    const m = g && g.messages.find((mm) => mm.id === entry.contentId && mm.from === "me");
    if (!g || !m) return null;
    return { ownerChat: g, targetMsg: m };
  }

  function markMessageAck(contactId, msgId, ack) {
    const rank = { failed: -1, sent: 0, delivered: 1, read: 2 };
    const entry = outbox.get(msgId);
    const groupId = entry && entry.payload && entry.payload.groupId;
    const contentId = entry && entry.payload && entry.payload.id;
    let ownerChat = null, targetMsg = null;
    if (groupId && contentId) {
      const g = contacts.get(groupId);
      const m = g && g.messages.find((mm) => mm.id === contentId && mm.from === "me");
      if (m) { ownerChat = g; targetMsg = m; }
    }
    if (!targetMsg) {
      const resolved = resolveGroupDelivery(msgId);
      if (resolved) { ownerChat = resolved.ownerChat; targetMsg = resolved.targetMsg; }
    }
    if (!targetMsg) {
      const c = contacts.get(contactId);
      const m = c && c.messages.find((mm) => mm.id === msgId && mm.from === "me");
      if (m) { ownerChat = c; targetMsg = m; }
    }
    if (!targetMsg) {
      for (const g of contacts.values()) {
        if (!g.isGroup) continue;
        const m = g.messages.find((mm) => mm.id === msgId && mm.from === "me");
        if (m) { ownerChat = g; targetMsg = m; break; }
      }
    }
    if (targetMsg && ((rank[ack] ?? 0) >= (rank[targetMsg.ack] ?? 0) || ack === "failed")) targetMsg.ack = ack;
    return !!targetMsg;
  }

  // 1) Отправка группового сообщения bob'у: отдельный deliveryId,
  //    запись в outbox И в groupDeliveryMap (см. sendGroupMessage).
  const deliveryId = "delivery-uuid-1";
  outbox.set(deliveryId, { payload: { kind: "chat", groupId: "g1", id: "content-1" } });
  groupDeliveryMap.set(deliveryId, { groupId: "g1", contentId: "content-1" });

  // 2) Сервер подтверждает приём конверта в mailbox (deliver-ack) —
  //    outbox-запись удаляется немедленно, groupDeliveryMap остаётся.
  outbox.delete(deliveryId);

  // 3) Много позже bob оказывается онлайн и шлёт настоящую квитанцию
  //    "доставлено", а потом "прочитано" — с тем же deliveryId.
  const deliveredOk = markMessageAck("bob", deliveryId, "delivered");
  check("ack 'delivered', пришедший после удаления outbox-записи, находит сообщение в группе", deliveredOk && contacts.get("g1").messages[0].ack === "delivered");

  const readOk = markMessageAck("bob", deliveryId, "read");
  check("ack 'read', пришедший после удаления outbox-записи, тоже находит сообщение (не застревает на 'delivered')", readOk && contacts.get("g1").messages[0].ack === "read");

  // Личные (не групповые) ack'и не должны случайно резолвиться через
  // groupDeliveryMap — у них там просто нет записи.
  contacts.get("bob").messages.push({ id: "private-msg-1", from: "me", ack: "sent" });
  const privateOk = markMessageAck("bob", "private-msg-1", "delivered");
  check("личный (1-к-1) ack продолжает резолвиться как раньше, минуя groupDeliveryMap", privateOk && contacts.get("bob").messages[0].ack === "delivered");
}

console.log(`\nИтого: ${pass} прошло, ${fail} упало`);
process.exit(fail > 0 ? 1 : 0);
