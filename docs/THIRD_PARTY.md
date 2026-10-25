# Сторонние компоненты и лицензии

Все библиотеки и шрифты лежат в репозитории (без CDN для кода приложения). Подробности по JS-библиотекам: [js/vendor/THIRD_PARTY_LICENSES.md](../js/vendor/THIRD_PARTY_LICENSES.md).

## Код

| Компонент | Файл | Версия | Лицензия |
|---|---|---|---|
| qrcode-generator (Kazuhiko Arase) | `js/vendor/qrcode-generator*.js` | 2.0.4 | MIT |
| jsQR (cozmo) | `js/vendor/jsQR.js` | 1.4.0 | Apache-2.0 |
| @noble/post-quantum 0.7.1 + @noble/hashes 2.4.0 (Paul Miller), ML-KEM-768 | `js/vendor/ml-kem768.js` | 0.7.1 / 2.4.0 | MIT; SHA-384 `DHLaLw9quG9pG/WT5R+XYI6dWERxqemuZplgOLXLnkOQUp/ofJ8rJ8uX3EaqQuie` |
| transformers.js (Hugging Face) | `js/vendor/transformers.min.js` | 3.0.0 | Apache-2.0 |
| onnxruntime-web (входит в transformers.js; wasm-файлы загружаются при включении локального ИИ с cdn.jsdelivr.net) | — | из transformers 3.0.0 | MIT |
| Модель Whisper (OpenAI), конвертация Xenova/whisper-base и -tiny | загружается с huggingface.co по согласию | — | MIT (Whisper); карточки Xenova: см. репозиторий модели |

Серверные зависимости (`ws`, `web-push` и др.) перечислены в `signaling-server/package.json`; лицензии — в их пакетах (`npm ls --all`).

## Шрифты (SIL Open Font License 1.1)

Inter — основной шрифт (`fonts/InterVariable.woff2`). Шрифты скинов лежат в `fonts/skins/` и подключаются только активным скином.

| Семейство | Файлы | Лицензия |
|---|---|---|
| Inter | InterVariable | OFL 1.1 |
| Bellota Text | bellota-text-400/700 | OFL 1.1 |
| Comfortaa | comfortaa-400/700 | OFL 1.1 |
| Manrope | manrope-300/700 | OFL 1.1 |
| Montserrat Alternates | montserrat-alternates-400/700 | OFL 1.1 |
| Neucha | neucha-400 | OFL 1.1 |
| Nunito | nunito-400/800 | OFL 1.1 |
| Play | play-400/700 | OFL 1.1 |
| Podkova | podkova-400/700 | OFL 1.1 |
| Russo One | russo-one-400 | OFL 1.1 |
| Tektur | tektur-400/700 | OFL 1.1 |
| Yeseva One | yeseva-one-400 | OFL 1.1 |

Тексты лицензий: OFL — https://openfontlicense.org/ ; Apache-2.0 — https://www.apache.org/licenses/LICENSE-2.0 ; MIT — https://opensource.org/license/mit . Авторские права принадлежат авторам семейств (см. страницы шрифтов на fonts.google.com). Шрифты используются без изменения начертаний, лишь в формате woff2 с подмножествами символов.

## Звуки и иконки

**Звуки скинов** синтезируются кодом (WebAudio, `js/skins.js`, `js/app/03-audio-pin.js`) — внешних аудио-файлов и лицензий у них нет.

**Иконки интерфейса** (`js/icons.js`) — собственные SVG проекта, сторонних наборов нет. PNG-иконки приложения (`icons/`: favicon, apple-touch-icon, icon-192/512, logo-256) — собственный логотип.

**Готовые файлы `sounds/*.mp3`** (мелодии звонка, сигналы вызова и сообщений: `ring-*`, `call-*`, `msg*`) загружены владельцем репозитория, который подтвердил, что права на них проверены (см. раздел «Звуки»).


## Звуки (sounds/)
Все файлы в `sounds/` (включая `msg.mp3` и `msg-icq-style.mp3`) — оригиналы, загруженные владельцем репозитория. Владелец подтвердил, что права на них проверены и претензий правообладателей не будет (решение владельца, V.78). Ранее заменённые синтезированные версии `msg.mp3` и `msg-icq-style.mp3` возвращены к оригиналам.
