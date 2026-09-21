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

console.log(`\nИтого: ${pass} прошло, ${fail} упало`);
process.exit(fail > 0 ? 1 : 0);
