# ether-sdk

Маленький SDK без зависимостей для **ботов и мостов** The Messenger (Ether) на Node.js ≥ 22. Реализует клиентскую сторону открытого протокола v1
([docs/PROTOCOL-V1.md](../docs/PROTOCOL-V1.md)): регистрация на сигнальном сервере, личность, prekey-пакеты (X3DH + ML-KEM-768), Double Ratchet,
приём офлайн-почты, каналы.

Криптографию SDK **не переписывает**: он загружает те же файлы, что работают в приложении (`js/ratchet.js`, `js/crypto-helper.js`, `js/channels.js`,
`js/vendor/ml-kem768.js`). Исправление в `js/` сразу попадает и в SDK. Из репозитория SDK берёт `../js/`; при `npm pack` скрипт `prepack` кладёт копию в `sdk/js/`.

## Быстрый старт

```js
const { Client, generateIdentity } = require("ether-sdk");   // или: import { Client, generateIdentity } from "ether-sdk";

const identity = await generateIdentity({ name: "Echo" });   // сохраните JSON: id и ключи — это и есть бот
const bot = new Client({ url: "wss://your-relay.example", identity, statePath: "./bot.state.json" });

bot.on("message", async ({ from, text }) => { if (text != null) await bot.sendText(from, "echo: " + text); });
await bot.connect();
console.log(bot.contactLink("https://arthurhuskyman.github.io/ether/"));   // откройте в приложении, чтобы добавить бота
```

Готовый пример: [`examples/echo-bot.js`](examples/echo-bot.js) (`ETHER_URL=ws://localhost:8787 node examples/echo-bot.js`).

## API

| | |
|---|---|
| `generateIdentity({name, id?})` | новая личность `{id, name, claimToken, publicKeyJwk, privateKeyJwk}`; `id` — любая строка ≤ 128 символов без `#` |
| `new Client({url, identity, statePath?, visible?, watch?, trust?, reconnect?, WebSocket?, log?})` | клиент. `statePath` — файл сессий и закреплённых ключей (0600, запись атомарная) |
| `await client.connect()` | регистрация, выкладывание prekey при необходимости; резолвится после события `ready` |
| `client.send(to, payload)` / `sendText(to, text)` | зашифровать (Double Ratchet) и доставить; резолвится `msgId` после `deliver-ack` сервера |
| `client.addPeer(id, publicKeyJwk)` | явно закрепить ключ контакта (обычно ключ приходит сам: `fromPublicKey` во входящем, присутствие, ростер) |
| `client.createChannel({name, desc, enc})`, `postToChannel(id, content)`, `subscribeChannel(link)` | каналы с подписью владельца (docs/CHANNELS-GROUPS.md) |
| `client.contactLink(appUrl)` | ссылка `#add=<id>&name=…` для добавления бота в приложении |
| события | `ready`, `message {from,msgId,kind,payload,text}`, `peer`, `key-changed`, `decrypt-error`, `presence`, `channel-post`, `error`, `close`, `raw` |

## Модель доверия и ограничения (честно)

- **TOFU**: первый увиденный публичный ключ контакта закрепляется. Другой ключ позже → событие `key-changed`, сообщения не расшифровываются; принять
  новый ключ можно только осознанно (`addPeer` или `trust: "update"`). Сверка safety number — вне SDK (`CryptoHelper.computeSafetyNumber` в `js/crypto-helper.js`).
- Сервер видит метаданные (кто кому и когда пишет), но не содержимое: см. docs/THREAT-MODEL.md. **Бот — это конечная точка**: он видит открытый текст,
  а значит вся ответственность за хранение и логи на авторе бота. Мост в другую сеть (Matrix, Telegram, …) по определению снимает E2E на своей стороне.
- Один `Client` = одна личность = один процесс-владелец `statePath`. Двух процессов с одним состоянием быть не должно: храповик расходится.
- Поддерживаются личные чаты (отправка Double Ratchet; приём также env2/v1) и каналы. Группы Sender Keys (`gdeliver`) и звонки в SDK пока не реализованы — такие сообщения приходят как событие `raw`.
- Протокол v1 заморожен для совместимости, но SDK версии 0.x — API может меняться.

Тесты: `cd tests && node --test sdk.test.js protocol-v1.test.js`.
