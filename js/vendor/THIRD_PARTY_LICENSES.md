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

## ml-kem768.js
- Проект: https://github.com/paulmillr/noble-post-quantum (`ml-kem.js`) + https://github.com/paulmillr/noble-hashes (sha3/utils), оба автор Paul Miller
- Лицензия: MIT (текст ниже)
- Версии: @noble/post-quantum 0.7.1, @noble/hashes 2.4.0 (получены `npm pack` / `npm i` через прокси песочницы, собраны esbuild в один IIFE, minify; логика не менялась)
- Назначение: ML-KEM-768 (FIPS 203) для гибридного PQ-обмена ключами в js/ratchet.js, когда нативного WebCrypto ML-KEM нет
- SHA-384 (base64) файла js/vendor/ml-kem768.js: `DHLaLw9quG9pG/WT5R+XYI6dWERxqemuZplgOLXLnkOQUp/ofJ8rJ8uX3EaqQuie`
- Проверка: `openssl dgst -sha384 -binary js/vendor/ml-kem768.js | base64`; тест tests/ratchet-pq.test.js сверяет хэш и KAT-векторы (tests/vectors/mlkem768-kat.json, получены независимой реализацией OpenSSL/ML-KEM через python-cryptography 49.0.0)

```
The MIT License (MIT)

Copyright (c) 2024 Paul Miller (https://paulmillr.com)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
