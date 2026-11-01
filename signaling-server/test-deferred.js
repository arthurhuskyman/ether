// V.82: отложенная доставка (feature "deferred"): до nb получатель ничего не видит (ни живой пересылки, ни выдачи из ящика),
// после nb — живая доставка; отправитель может снять несозревшую запись, чужой — нет; nb вне окна игнорируется (обычная доставка).
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const WebSocket = require("ws");
const PORT = 8853, URL = "ws://localhost:" + PORT;
const FILE = path.join(os.tmpdir(), "ether-deferred-" + process.pid + ".json");
const idA = "da11da11da11da11da11da11da11da11da11da11da11da11da11da11da11da11";
const idB = "db22db22db22db22db22db22db22db22db22db22db22db22db22db22db22db22";
const idC = "dc33dc33dc33dc33dc33dc33dc33dc33dc33dc33dc33dc33dc33dc33dc33dc33";
let pass = 0, fail = 0;
function check(label, cond) { if (cond) { pass++; console.log("  OK   " + label); } else { fail++; console.log("  FAIL " + label); } }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function connect(id) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL); const events = [];
    ws.on("error", reject);
    ws.on("open", () => ws.send(JSON.stringify({ type: "register", id, name: id.slice(0, 2), visible: true })));
    ws.on("message", (raw) => events.push(JSON.parse(raw)));
    ws.on("open", () => setTimeout(() => resolve({ ws, events }), 250));
  });
}
async function connectRetry(id) { for (let i = 0; i < 40; i++) { try { return await connect(id); } catch (e) { await wait(100); } } throw new Error("сервер не поднялся"); }
const send = (c, o) => c.ws.send(JSON.stringify(o));
const env = { iv: "AAAA", ct: "BBBB", v: 1, rc: 1 };
(async () => {
  try { fs.unlinkSync(FILE); } catch (e) {}
  const srv = spawn(process.execPath, [path.join(__dirname, "server.js")], { env: Object.assign({}, process.env, { PORT: String(PORT), MAILBOX_FILE: FILE, CLAIMS_PERSIST: "0", DEFER_SWEEP_MS: "300", VAPID_PUBLIC: "", VAPID_PRIVATE: "" }), stdio: "ignore" });
  try {
    const A = await connectRetry(idA), B = await connectRetry(idB), C = await connectRetry(idC);
    const reg = A.events.find((e) => e.type === "registered");
    check("сервер объявляет feature deferred", !!(reg && Array.isArray(reg.features) && reg.features.includes("deferred")));
    const got = (c, m) => c.events.filter((e) => e.type === "deliver" && e.msgId === m).length;
    send(A, { type: "deliver", to: idB, msgId: "d1", envelope: env, kind: "chat", nb: Date.now() + 6000 });
    await wait(400);
    const ack = A.events.find((e) => e.type === "deliver-ack" && e.msgId === "d1");
    check("deliver-ack с отметкой deferred", !!(ack && ack.deferred));
    check("до nb онлайн-получатель ничего не получил", got(B, "d1") === 0);
    B.ws.close(); await wait(200);
    const B2 = await connectRetry(idB);
    check("до nb ящик не выдаёт запись при подключении", got(B2, "d1") === 0);
    await wait(6200);
    check("после nb запись доставлена онлайн-получателю", got(B2, "d1") === 1);
    // отмена
    send(A, { type: "deliver", to: idB, msgId: "d2", envelope: env, kind: "chat", nb: Date.now() + 60000 });
    await wait(200);
    send(C, { type: "mailbox-cancel", to: idB, msgId: "d2" }); await wait(200);
    check("чужой не может снять отложенную запись", !!C.events.find((e) => e.type === "mailbox-cancelled" && e.msgId === "d2" && e.ok === false));
    send(A, { type: "mailbox-cancel", to: idB, msgId: "d2" }); await wait(200);
    check("отправитель снимает свою отложенную запись", !!A.events.find((e) => e.type === "mailbox-cancelled" && e.msgId === "d2" && e.ok === true));
    // nb вне окна (в прошлом / дальше 7 суток) — обычная доставка сразу
    send(A, { type: "deliver", to: idB, msgId: "d3", envelope: env, kind: "chat", nb: Date.now() - 1000 }); await wait(300);
    check("nb в прошлом — доставка сразу", got(B2, "d3") === 1);
    send(A, { type: "deliver", to: idB, msgId: "d4", envelope: env, kind: "chat", nb: Date.now() + 30 * 24 * 3600 * 1000 }); await wait(300);
    check("nb дальше 7 суток — доставка сразу", got(B2, "d4") === 1);
    for (const c of [A, B2, C]) c.ws.close();
  } catch (e) { fail++; console.log("  FAIL исключение: " + e.message); }
  srv.kill(); try { fs.unlinkSync(FILE); } catch (e) {}
  console.log("\nИтого: " + pass + " прошло, " + fail + " упало");
  process.exit(fail ? 1 : 0);
})();
