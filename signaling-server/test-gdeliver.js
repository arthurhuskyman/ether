// gdeliver (Sender Keys): один конверт -> fan-out участникам группы, ящик для офлайн, реестр группы, лимиты, совместимость.
const WebSocket = require("ws");
process.env.PORT = "8812"; process.env.MAILBOX_PERSIST = "0"; process.env.VAPID_PUBLIC = ""; process.env.VAPID_PRIVATE = ""; process.env.GROUP_MAX_MEMBERS = "6"; process.env.GROUPS_PERSIST = "0"; process.env.CHANNELS_PERSIST = "0"; process.env.GDELIVER_PER_MIN = "12";
require("./server.js");
let pass = 0, fail = 0;
function check(label, cond) { if (cond) { pass++; console.log("  OK   " + label); } else { fail++; console.log("  FAIL " + label); } }
const w = (ms) => new Promise((r) => setTimeout(r, ms));
const open = (id) => new Promise((resolve) => { const ws = new WebSocket("ws://localhost:8812"); const ev = []; ws.on("message", (r) => ev.push(JSON.parse(r))); ws.on("open", () => { ws.send(JSON.stringify({ type: "register", id, name: id, visible: true, caps: ["env2", "sk1"] })); setTimeout(() => resolve({ ws, ev, send: (o) => ws.send(JSON.stringify(o)) }), 200); }); });
const env = (n, tag) => ({ v: "sk1", cid: "chain0001", n, iv: "aXYxMjM0NTY3OA==", ct: Buffer.from(tag || "ct").toString("base64"), sig: "c2lnbmF0dXJl" });
(async () => {
  await w(400);
  const GID = "grp-test-0001", ids = ["u-a", "u-b", "u-c", "u-d"];
  const [A, B, C] = await Promise.all(ids.slice(0, 3).map(open));
  A.send({ type: "group-roster", gid: GID, members: ids, ver: 1 }); await w(150);
  check("реестр: первая регистрация принята", A.ev.some((e) => e.type === "group-roster-ack" && !e.error && e.ver === 1));
  A.send({ type: "gdeliver", gid: GID, msgId: "m1", to: ids.filter((i) => i !== "u-a"), envelope: env(0) }); await w(250);
  const ack = A.ev.find((e) => e.type === "gdeliver-ack" && e.msgId === "m1");
  check("ack: 2 онлайн, 1 в ящик", ack && ack.live === 2 && ack.queued === 1 && !ack.error);
  const b1 = B.ev.find((e) => e.type === "deliver" && e.msgId === "m1"), c1 = C.ev.find((e) => e.type === "deliver" && e.msgId === "m1");
  check("онлайн получают один и тот же конверт kind=gchat с gid и from", b1 && c1 && b1.kind === "gchat" && b1.gid === GID && b1.from === "u-a" && b1.envelope.ct === c1.envelope.ct && b1.envelope.cid === "chain0001");
  check("отправитель не получает свою копию", !A.ev.some((e) => e.type === "deliver" && e.msgId === "m1"));
  B.send({ type: "mailbox-ack", msgId: "m1" }); await w(100);
  const D = await open("u-d");
  check("офлайн участник получает из ящика при входе (queued)", D.ev.some((e) => e.type === "deliver" && e.msgId === "m1" && e.queued && e.kind === "gchat" && e.gid === GID));
  // не участник
  const X = await open("u-x");
  X.send({ type: "gdeliver", gid: GID, msgId: "m2", to: ids, envelope: env(0) }); await w(150);
  check("не участник реестра отвергнут", X.ev.some((e) => e.type === "gdeliver-ack" && e.error === "not-member") && !B.ev.some((e) => e.msgId === "m2"));
  // отправитель добавил постороннего в список
  A.send({ type: "gdeliver", gid: GID, msgId: "m3", to: [...ids, "u-x"], envelope: env(1) }); await w(200);
  const a3 = A.ev.find((e) => e.type === "gdeliver-ack" && e.msgId === "m3");
  check("получатели вне реестра отброшены (dropped=1)", a3 && a3.dropped === 1 && !X.ev.some((e) => e.type === "deliver" && e.msgId === "m3"));
  // отправитель вправе исключить
  A.send({ type: "gdeliver", gid: GID, msgId: "m4", to: ["u-b"], envelope: env(2) }); await w(150);
  check("подмножество получателей допустимо", B.ev.some((e) => e.msgId === "m4") && !C.ev.some((e) => e.msgId === "m4"));
  // смена состава: только админ и с большим ver
  B.send({ type: "group-roster", gid: GID, members: ["u-b"], ver: 5 }); await w(100);
  check("не-админ не меняет реестр", B.ev.some((e) => e.type === "group-roster-ack" && e.error === "not-admin"));
  A.send({ type: "group-roster", gid: GID, members: ["u-a", "u-b", "u-c"], ver: 1 }); await w(100);
  check("устаревший ver отвергнут", A.ev.filter((e) => e.type === "group-roster-ack").pop().error === "stale");
  A.send({ type: "group-roster", gid: GID, members: ["u-a", "u-b", "u-c"], ver: 2 }); await w(100);
  C.send({ type: "gdeliver", gid: GID, msgId: "m5", to: ["u-a", "u-d"], envelope: env(0) }); await w(150);
  check("исключённый из реестра (u-d) не получает", !D.ev.some((e) => e.msgId === "m5") && A.ev.some((e) => e.msgId === "m5"));
  // кик отправителя
  A.send({ type: "group-roster", gid: GID, members: ["u-a", "u-b"], ver: 3 }); await w(100);
  C.send({ type: "gdeliver", gid: GID, msgId: "m6", to: ["u-a"], envelope: env(1) }); await w(100);
  check("исключённый участник больше не может слать", C.ev.some((e) => e.type === "gdeliver-ack" && e.msgId === "m6" && e.error === "not-member"));
  // лимиты
  A.send({ type: "gdeliver", gid: "grp-big-0001", msgId: "m7", to: Array.from({ length: 7 }, (_, i) => "big" + i), envelope: env(0) }); await w(100);
  check("больше GROUP_MAX_MEMBERS(6) получателей: too-many", A.ev.some((e) => e.type === "gdeliver-ack" && e.msgId === "m7" && e.error === "too-many"));
  A.send({ type: "gdeliver", gid: GID, msgId: "m8", to: ["u-b"], envelope: { v: "sk1", cid: "c", n: -1, iv: "a", ct: "b", sig: "c" } }); await w(100);
  check("невалидный конверт", A.ev.some((e) => e.msgId === "m8" && e.error === "invalid-envelope"));
  A.send({ type: "gdeliver", gid: GID, msgId: "m9", to: ["u-b"], envelope: { v: 2, iv: "aa", ct: "bb" } }); await w(100);
  check("чужой формат конверта отвергнут (только sk1)", A.ev.some((e) => e.msgId === "m9" && e.error === "invalid-envelope"));
  for (let i = 0; i < 14; i++) A.send({ type: "gdeliver", gid: GID, msgId: "r" + i, to: ["u-b"], envelope: env(10 + i) });
  await w(300);
  check("лимит частоты на отправителя", A.ev.some((e) => e.type === "gdeliver-ack" && e.error === "rate"));
  // авто-регистрация новой группы
  const E = await open("u-e");
  E.send({ type: "gdeliver", gid: "grp-auto-0001", msgId: "n1", to: ["u-b"], envelope: env(0) }); await w(150);
  check("неизвестная группа регистрируется первым отправителем", E.ev.some((e) => e.type === "gdeliver-ack" && e.msgId === "n1" && !e.error) && B.ev.some((e) => e.msgId === "n1"));
  // совместимость: старое поведение deliver не затронуто
  A.send({ type: "deliver", to: "u-b", msgId: "old1", envelope: { iv: "aXY=", ct: "Y3Q=" }, kind: "chat" }); await w(150);
  check("обычный deliver работает как раньше", B.ev.some((e) => e.type === "deliver" && e.msgId === "old1" && e.kind === "chat" && !e.gid));
  // неявная регистрация заменяется явным ростером участника (а явный чужой не перехватить)
  E.send({ type: "group-roster", gid: "grp-auto-0001", members: ["u-e", "u-b"], ver: 1 }); await w(100);
  check("явный ростер участника заменяет неявно созданный", E.ev.filter((e) => e.type === "group-roster-ack").pop().ver === 1);
  B.send({ type: "group-roster", gid: "grp-auto-0001", members: ["u-b"], ver: 9 }); await w(100);
  check("после явной регистрации чужой не-админ ростер не меняет", B.ev.filter((e) => e.type === "group-roster-ack").pop().error === "not-admin");
  console.log("\n" + pass + " ok, " + fail + " fail");
  setTimeout(() => process.exit(fail ? 1 : 0), 100);
})();
