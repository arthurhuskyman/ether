# Протокол V.79: доставка звонка при закрытом приложении и звонок по ссылке

Общий контракт сервера (signaling-server) и клиента (sw.js, js/app/*). Любое изменение — в обеих сторонах сразу.

## A. Серия «гудков» (web-push)
При call-invite офлайн-получателю (или получателю без активного сокета) сервер шлёт серию push: #1 сразу, затем каждые 5 с, не более 6, пока не наступит условие остановки (приглашение доставлено сокету, call-accept/call-decline/call-cancel/call-end, дисконнект звонящего, 45 с).
Заголовки web-push: `Urgency: high`, `TTL: 30`, `Topic: ring-<callId[:8]>-<seq>` (разный на каждый push).
Payload (JSON): `{t:"call-ring", callId, from, name, seq, total, video, ackToken}`.
Service worker на `call-ring`: закрывает прежние уведомления этого callId и показывает новое (title «📞 {name} звонит», body «Нажмите, чтобы ответить», tag `ring-<callId>`, data {callId, from, url:`/#answer=<callId>&from=<id>`}), затем (не блокируя показ) делает `fetch POST <httpBase>/push-ack {callId, seq, ackToken}` (keepalive). Тихих push нет: каждый push показывает уведомление, кроме случая, когда есть видимое окно приложения.

## B. Отмена
Сервер шлёт `{t:"call-cancel", callId, reason:"answered"|"cancelled"|"timeout"|"declined"}`. SW закрывает уведомления callId; для cancelled/timeout показывает «Пропущенный звонок от {name}» (tag `missed-<callId>`), для answered/declined — короткое «Звонок завершён» (обязательное уведомление; пропускается, если есть видимое окно).

## C. Подтверждение доставки звонящему
`POST /push-ack` (CORS для origin приложения, rate-limit по IP, токен: HMAC(secret, callId|seq|subscriptionHash), одноразовый). Сервер шлёт звонящему по WS `{t:"call-ringing", callId}` (один раз). Клиент звонящего показывает «Звонит у собеседника…» вместо «Вызываем…».

## D. Открытие по уведомлению
URL `/#answer=<callId>&from=<id>`: приложение сразу рисует экран «Входящий звонок от {имя из контакта/hash}» с кнопкой «Ответить» (нужен тап для микрофона), параллельно подключается к серверу; сервер держит неотвеченное приглашение 45 с и отдаёт его при регистрации. Если приглашение истекло — экран «Звонок завершён. Перезвонить?».

## E. Звонок по ссылке (link-call), WS-сообщения
- `linkcall-create {}` (зарегистрированный клиент) → `linkcall-created {room, code, expiresAt}`; room = 128 бит base64url, code = 6 цифр уникален среди активных комнат; TTL 10 мин до входа гостя; ≤3 активных комнат на id; rate-limit.
- `linkcall-join {room | code, name?}` (допустимо с НЕзарегистрированного сокета; rate-limit по IP: 20/мин room, 5/мин code) → создателю `linkcall-guest {room, guestRef, name, viaCode}`; присоединяющемуся `linkcall-joined {room}` или `linkcall-error {reason:"expired|full|notfound|ratelimit"}`. Один гость на комнату.
- `linkcall-allow {room, guestRef}` / `linkcall-deny {room, guestRef}` от создателя. Для входа по ссылке с секретом клиент создателя авто-разрешает после проверки секрета (см. ниже), для входа по коду — только ручное подтверждение создателем.
- `linkcall-signal {room, data}` в обе стороны (сервер ретранслирует непрозрачные SDP/ICE только между двумя сокетами комнаты), `linkcall-end {room}`; комната закрывается при закрытии любого из двух сокетов и через 2 ч максимум.
- Секрет `k` (16 байт) только во фрагменте ссылки `#call=<room>.<k>`; обе стороны кладут в signal-данные HMAC(k, DTLS-fingerprint локальный|удалённый); несовпадение — разрыв. Вход по коду секрета не имеет: создатель подтверждает вручную и видит короткую сверочную строку (4 эмодзи из отпечатков).
- Ссылка: `https://<origin>/#call=<room>.<k>`; сообщение: «{name} зовёт вас на звонок в The Messenger: {ссылка} (действует 10 минут). Или введите код {code} в приложении.»

## Уточнения сервера
- callId берётся из `call-invite`: `data.callId`, иначе `data.x` (формат `[A-Za-z0-9_-]{4,64}`), иначе генерируется сервером. Повтор приглашения той же пары, пока серия идёт, игнорируется (клиентские ретраи не плодят push). Клиент должен слать один и тот же callId во всех ретраях.
- Онлайн-получателю с push-подпиской серия стартует с задержкой `RING_ONLINE_GRACE_MS` (4 с) и отменяется, если он ответил `call-invite-ack` (или accept/decline); без ack (мёртвый сокет iOS) гудки идут. Офлайн — push #1 сразу.
- Условия остановки по сигналам `data.t`: `call-invite-ack` (получатель) → тихо; `call-accepted` → cancel `answered`; `call-declined`/`call-busy` и `call-ended` от получателя → `declined`; `call-ended` от звонящего и дисконнект звонящего → `cancelled`; 45 с → `timeout`. Регистрация получателя (приглашение отдано сокету) и 404/410 подписки останавливают серию без cancel push. Cancel push: `{t:"call-cancel", callId, reason, from, name}` (есть `name` для «Пропущенный звонок от…»), urgency high, TTL 30, topic `cancel-<callId[:8]>`; уходит только если был хотя бы один ring. Онлайн-получателю дополнительно WS `{type:"call-cancel", callId, from, reason}`.
- Payload ring/cancel — обычный JSON (не declarative 8030), SW обязателен.
- `/push-ack`: тело `{callId, seq, ackToken}`; ответы 200 `{ok:true}` (повтор токена: `{ok:true,dup:true}`, без повторного call-ringing), 403 (токен/callId/seq/origin), 429, 413. Запись звонка живёт 60 с после остановки (запоздавший ack проверяется, но call-ringing после завершения звонка не шлётся). Origin: из `APP_BASE_URL`/`ALLOWED_ORIGIN`/`PUSH_ACK_ORIGINS`; запрос без Origin допускается (защищён токеном).
- `push-test-ring` (зарегистрированный клиент с подпиской) → `push-test-started {callId,total:3}` или `push-test-error {reason: disabled|nosub|ratelimit}`; callId `test-<hex>`; ack такого push → `call-ringing` самому клиенту; cancel push для теста не шлётся.
- Link-call: `linkcall-signal` ретранслируется между сокетами комнаты сразу после входа гостя (до allow: нужно для проверки секрета создателем); `linkcall-allow` → гостю `linkcall-allowed {room}`; `linkcall-deny` → гостю `linkcall-denied {room}`, слот гостя освобождается, комната живёт до исходного expiresAt. Комната закрывается: создателем/гостем `linkcall-end`, закрытие любого сокета, TTL 10 мин (только до входа гостя), 2 ч. Партнёру приходит `linkcall-end {room, reason}`; создателю также при истечении. Лимиты: комнат на id ≤3, create 6/мин на id, signal ≤64 КБ.
- Гость-незарегистрированный не закрывается по таймауту регистрации после успешного `linkcall-join`.
