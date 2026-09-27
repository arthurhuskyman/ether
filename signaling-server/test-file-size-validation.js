// Раньше этот тест дословно ДУБЛИРОВАЛ условия валидации как локальные
// функции — если бы порог в app.js однажды изменился, тест остался бы
// зелёным и не заметил расхождения. Теперь требует ТОТ ЖЕ файл
// (js/file-limits.js, UMD), что подключает и сам app.js через
// <script> — единственный источник правды вместо двух копий.
const { MAX_FILE_SIZE, isValidFileMetaSize, chunkExceedsBudget } = require("../js/file-limits.js");

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log("  OK   " + label); }
  else { fail++; console.log("  FAIL " + label); }
}

console.log("\n=== file-meta: payload.size ===");
check("нормальный размер (100КБ) проходит", isValidFileMetaSize(100 * 1024));
check("ровно MAX_FILE_SIZE проходит", isValidFileMetaSize(MAX_FILE_SIZE));
check("на 1 байт больше MAX_FILE_SIZE — отклонено (это и был баг: раньше вообще не проверялось)", !isValidFileMetaSize(MAX_FILE_SIZE + 1));
check("заявленный гигабайт — отклонено", !isValidFileMetaSize(1024 * 1024 * 1024));
check("size=0 — отклонено", !isValidFileMetaSize(0));
check("отрицательный size — отклонено", !isValidFileMetaSize(-100));
check("size не число (строка) — отклонено", !isValidFileMetaSize("100000"));
check("size = NaN — отклонено", !isValidFileMetaSize(NaN));
check("size = Infinity — отклонено", !isValidFileMetaSize(Infinity));
check("size = null — отклонено", !isValidFileMetaSize(null));
check("size = undefined — отклонено", !isValidFileMetaSize(undefined));

console.log("\n=== file-chunk: суммарный объём не должен убегать от заявленного size ===");
{
  // Пир заявил в file-meta крошечный size (100 байт), но пытается
  // прислать 500 кусков по 100КБ base64 каждый — ровно тот сценарий
  // DoS из отчёта: totalChunks ограничен (500 в app.js), но НИЧТО не
  // проверяло, что реальный объём соответствует заявленному size.
  const declaredSize = 100;
  let received = 0;
  let rejectedAt = -1;
  for (let i = 0; i < 500; i++) {
    const chunkLen = 100 * 1024; // 100КБ на кусок — совсем не похоже на "100 байт всего"
    if (chunkExceedsBudget(received, chunkLen, declaredSize)) { rejectedAt = i; break; }
    received += chunkLen;
  }
  check("атака (заявлен 100 байт, шлют по 100КБ) обрывается быстро, а не после всех 500 кусков", rejectedAt >= 0 && rejectedAt < 5);
  console.log("  (диагностика) оборвано на куске #" + rejectedAt + ", реального сценария DoS до 500 кусков не случилось");
}
{
  // Легитимный сценарий: заявлен честный size (1.5МБ), кускуют его
  // нормальными кусками — не должно ложно отклоняться.
  const declaredSize = 1.5 * 1024 * 1024;
  const totalChunks = 32;
  const chunkLen = Math.ceil((declaredSize * 4 / 3) / totalChunks);
  let received = 0;
  let rejected = false;
  for (let i = 0; i < totalChunks; i++) {
    if (chunkExceedsBudget(received, chunkLen, declaredSize)) { rejected = true; break; }
    received += chunkLen;
  }
  check("честная передача 1.5МБ обычными кусками НЕ отклоняется ложноположительно", !rejected);
}

console.log("\nИтого: " + pass + " прошло, " + fail + " упало");
process.exit(fail > 0 ? 1 : 0);
