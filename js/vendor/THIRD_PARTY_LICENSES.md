# Стороннее ПО, включённое в проект

Оба файла вшиты локально (не через CDN), чтобы приложение оставалось
полностью офлайн-способным — ровно как весь остальной код.

## qrcode-generator.js, qrcode-generator-utf8.js
- Проект: https://github.com/kazuhikoarase/qrcode-generator
- Автор: Kazuhiko Arase
- Лицензия: MIT
- Версия: 2.0.4 (минифицирована через terser, без изменения логики)

## jsQR.js
- Проект: https://github.com/cozmo/jsQR
- Лицензия: Apache-2.0
- Версия: 1.4.0 (минифицирована через terser, без изменения логики)

## transformers.min.js
- Проект: https://github.com/huggingface/transformers.js
- Лицензия: Apache-2.0
- Версия: 3.0.0 (dist/transformers.min.js без изменений; SHA-384 закреплён в js/localai.js как TF_SHA384)
- Лежит на нашем origin, чтобы CSP не разрешал чужие скрипты. Подгружается лениво, только после согласия на локальный ИИ.
