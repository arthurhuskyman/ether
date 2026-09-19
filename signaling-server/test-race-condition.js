// Загружает НАСТОЯЩИЙ js/webrtc.js (без изменений и копий) в Node,
// подставив RTCPeerConnection из @roamhq/wrtc вместо браузерного глобала,
// и воспроизводит ровно ту гонку состояний, что видна в присланном логе:
// обе стороны почти одновременно решают быть "offerer", одна из них
// отменяет свою попытку в пользу чужого предложения ПОКА её собственный
// createInitialOffer() ещё не завершился.

const fs = require("fs");
const path = require("path");
const wrtc = require("@roamhq/wrtc");

global.RTCPeerConnection = wrtc.RTCPeerConnection;
global.crypto = global.crypto || require("crypto").webcrypto;

const src = fs.readFileSync(path.join(__dirname, "..", "js", "webrtc.js"), "utf8");
// eslint-disable-next-line no-eval
eval(src + "\nglobalThis.__PeerLink = PeerLink; globalThis.__MeshManager = MeshManager;");
const PeerLink = globalThis.__PeerLink;

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log("  OK   " + label); }
  else { fail++; console.log("  FAIL " + label); }
}

(async () => {
  console.log("\n=== Гонка: закрываем связь ровно во время createInitialOffer() ===");

  const link = new PeerLink({ id: "test-id", localName: "Тест", role: "offerer" });

  // Запускаем createInitialOffer, но НЕ ждём его — и почти сразу же (как
  // происходит в app.js при разрешении конфликта offerer/offerer) закрываем
  // связь, пока createOffer/setLocalDescription/ICE ещё выполняются.
  const offerPromise = link.createInitialOffer("");
  link.close(); // закрыть синхронно, следующей же строкой — гарантированно "во время" выполнения

  let threw = false;
  let result;
  try {
    result = await offerPromise;
  } catch (e) {
    threw = true;
    console.log("  (если бы фикса не было, здесь бы вылетело):", e.message);
  }

  check("createInitialOffer() НЕ выбросил исключение при закрытии во время выполнения", !threw);
  check("createInitialOffer() вернул null (сигнал 'отменено'), а не мусорный пакет", result === null);
  check("link.status стал disconnected после close()", link.status === "disconnected");

  console.log("\n=== Та же гонка для acceptOfferAndCreateAnswer() ===");

  // Готовим настоящий offer от отдельного, независимого пира, чтобы было
  // что "принимать" — иначе setRemoteDescription не с чем вызывать.
  const remote = new PeerLink({ id: "remote-id", localName: "Собеседник", role: "offerer" });
  const realOffer = await remote.createInitialOffer("");
  check("вспомогательный offer для теста создался", !!realOffer);

  const answerer = new PeerLink({ id: "test-id-2", localName: "Тест2", role: "answerer" });
  const answerPromise = answerer.acceptOfferAndCreateAnswer(realOffer);
  answerer.close(); // закрыть синхронно, следующей же строкой

  let threw2 = false;
  let result2;
  try {
    result2 = await answerPromise;
  } catch (e) {
    threw2 = true;
    console.log("  (если бы фикса не было, здесь бы вылетело):", e.message);
  }
  check("acceptOfferAndCreateAnswer() НЕ выбросил исключение при закрытии во время выполнения", !threw2);
  check("acceptOfferAndCreateAnswer() вернул null, а не мусорный пакет", result2 === null);

  remote.close();

  console.log(`\nИтого: ${pass} прошло, ${fail} упало`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error("Ошибка теста:", e);
  process.exit(1);
});