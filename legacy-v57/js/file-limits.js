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

  return { MAX_FILE_SIZE, isValidFileMetaSize, chunkExceedsBudget };
});
