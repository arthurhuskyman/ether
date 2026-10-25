// Общая логика проверки размера входящих файлов — используется и в
// app.js (браузер), и в test-file-size-validation.js (Node). Раньше
// тест дословно ДУБЛИРОВАЛ эти условия как отдельные локальные функции
// — если бы порог в app.js однажды изменился (например, +4096 байт
// запаса на кусок), тест остался бы зелёным и не заметил расхождения.
// Один источник правды вместо двух копий.
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.EtherFileLimits = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 МБ — целевой потолок того, что РЕАЛЬНО отправляется (держать в синхроне с app.js)

  function isValidFileMetaSize(size) {
    // Number.isFinite (в отличие от глобального isFinite) не делает
    // неявного приведения типов — для строки/null/undefined и так
    // вернёт false. Отдельная проверка typeof была избыточной.
    return Number.isFinite(size) && size > 0 && size <= MAX_FILE_SIZE;
  }

  function chunkExceedsBudget(receivedBytesSoFar, chunkLen, declaredSize) {
    const maxExpectedB64 = Math.ceil((declaredSize || MAX_FILE_SIZE) * 4 / 3) + 4096;
    return (receivedBytesSoFar + chunkLen) > maxExpectedB64;
  }

  // V.80: большие файлы по прямому P2P (двоичный протокол filebin1, js/bigfile.js). Офлайн-ящик и группы остаются малыми (MAX_FILE_SIZE / 1 МБ).
  const P2P_MAX_FILE_SIZE = 4 * 1024 * 1024 * 1024; // 4 ГиБ — потолок прямой передачи (настраиваемая константа; проверяется и у получателя против лживого meta)
  const BIG_MEMORY_CAP = 64 * 1024 * 1024; // запасной вариант «только в памяти» (нет OPFS/IndexedDB) — не больше 64 МиБ
  const BIG_RESUME_TTL_MS = 24 * 3600 * 1000; // сколько живёт недокачанная передача (докачка после перезапуска приложения)

  // Размер из file-meta большого файла (bin:1): целое число байт в пределах [1; P2P_MAX_FILE_SIZE].
  function isValidBigFileMetaSize(size, max) {
    return Number.isInteger(size) && size > 0 && size <= (max || P2P_MAX_FILE_SIZE);
  }

  return { MAX_FILE_SIZE, isValidFileMetaSize, chunkExceedsBudget, P2P_MAX_FILE_SIZE, BIG_MEMORY_CAP, BIG_RESUME_TTL_MS, isValidBigFileMetaSize };
});
