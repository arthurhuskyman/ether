# Настройка сервера сигнализации

Сервер: `signaling-server/` (Node ≥ 18). Он соединяет устройства, хранит зашифрованный офлайн-ящик и рассылает push. Контейнерный запуск и `.env`: [signaling-server/SELF_HOSTING.md](../signaling-server/SELF_HOSTING.md). Здесь — Render и TURN.

## Render + Persistent Disk
1. New → Blueprint, укажите репозиторий (`render.yaml`: rootDir `signaling-server`, `npm install --omit=dev`, `node server.js`, health `/health`).
2. Persistent Disk доступен на платных тарифах. Добавьте диск (например 1 ГБ), mount path `/var/data`.
3. Переменная `DATA_DIR=/var/data`. Без неё ящик, claims и push-подписки лежат во временной файловой системе и **пропадают при каждом перезапуске/деплое**.
4. Сгенерируйте VAPID: `cd signaling-server && npm run generate-vapid`; значения — в `VAPID_PUBLIC`, `VAPID_PRIVATE`, `VAPID_SUBJECT` (`mailto:вы@домен`).
5. `ALLOWED_ORIGIN` — адрес фронтенда (`https://<user>.github.io`), чтобы чужие сайты не ходили на сервер из браузера. `APP_BASE_URL` — ссылки в push.
6. Бесплатный Render засыпает через ~15 минут; `.github/workflows/keep-signaling-awake.yml` пингует `/health`. На платном тарифе его можно удалить.

## Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `PORT` | 8787 | порт (Render задаёт сам) |
| `DATA_DIR` | каталог сервера | где лежат ящик и claims (смонтируйте диск) |
| `MAILBOX_FILE`, `MAILBOX_PERSIST` | в `DATA_DIR`, включено | файл ящика; `0` — не писать на диск |
| `CLAIMS_FILE`, `CLAIMS_PERSIST` | в `DATA_DIR`, включено | claim-токены id |
| `PUSH_SUBS_FILE` | `.ether-push-subs.json` рядом с сервером | push-подписки; укажите путь на диске в `DATA_DIR` |
| `VAPID_PUBLIC`, `VAPID_PRIVATE`, `VAPID_SUBJECT` | — | ключи Web Push |
| `ALLOWED_ORIGIN` | `*` | разрешённый origin (CORS/WebSocket) — задайте в продакшене |
| `APP_BASE_URL` | из ALLOWED_ORIGIN | базовый URL приложения в push |
| `TRUST_PROXY` | включено | `0` — не доверять X-Forwarded-For (если нет прокси) |
| `STRICT_ROSTER` | выкл. | `1` — строгая проверка ростера групп, когда все клиенты обновлены |
| `TURN_STATIC_URL`, `TURN_STATIC_SECRET` | — | свой coturn с временными логинами (use-auth-secret) |
| `TURN_STATIC_USERNAME`, `TURN_STATIC_PASSWORD` | — | вариант с постоянной парой (менее безопасно) |
| `TURN_TTL_SECONDS` | 86400 | срок жизни временных TURN-логинов |
| `TURN_EXTRA_JSON` | — | дополнительные ICE-серверы JSON-массивом |
| `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN`, `CF_TURN_API_BASE` | — | TURN Cloudflare |
| `TURN_CHECK_DISABLED` | выкл. | `1` — отключить проверку TURN в отладке |
| `MAILBOX_MAX_PER_USER` / `_PER_SENDER` / `MAILBOX_MAX_TOTAL_ENTRIES` / `MAILBOX_MAX_TOTAL_BYTES` | 500 / 250 / 100000 / 400 МБ | лимиты ящика |
| `CLAIM_TTL_HOURS`, `CLAIMS_MAX`, `CLAIM_CREATE_PER_HOUR_PER_IP` | 336 / 200000 / 60 | claim-токены id |
| `MAX_SOCKETS_PER_IP`, `MAX_PUSH_SUBS`, `PREKEYS_MAX`, `REGISTER_DEADLINE_MS` | 40 / 20000 / 50000 / 15000 | прочие лимиты |
| `LINK_PREVIEW_IMAGE_MAX_BYTES`, `LINK_PREVIEW_IMAGE_CACHE_BYTES` | 1 МБ / 32 МБ | превью ссылок |

Сроки в ящике зашиты в коде: текст — 14 суток, файлы и голосовые — 48 часов.

## TURN (coturn, use-auth-secret)
Нужен, когда прямое P2P-соединение невозможно (мобильные сети, симметричный NAT).
1. VPS с белым IPv4, `sudo bash deploy/setup-coturn.sh [домен]` (скрипт ставит coturn; с доменом — TLS на 443).
2. В `/etc/turnserver.conf`: `use-auth-secret`, `static-auth-secret=<длинный случайный секрет>`, `realm=<ваш домен>`, `fingerprint`, `no-cli`, `no-multicast-peers`, запрет частных диапазонов (`denied-peer-ip=10.0.0.0-10.255.255.255` и т.п.), ограничение `total-quota`/`user-quota`.
3. Откройте порты 3478 (UDP/TCP), 5349/443 (TLS), диапазон relay `49152-65535/udp`.
4. На Render: `TURN_STATIC_URL=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:443?transport=tcp` и `TURN_STATIC_SECRET=<тот же секрет>`. Сервер выдаёт клиентам временные логины (HMAC-SHA1, срок `TURN_TTL_SECONDS`). Секрет только в переменных Render, не в репозитории.
5. Проверка: «Отладка» → проверка TURN должна показать `relay OK`.

## Чек-лист «перед запуском для людей»
- [ ] Persistent Disk смонтирован, `DATA_DIR` задан; после рестарта ящик на месте.
- [ ] VAPID-ключи заданы; push доходит на iPhone (из PWA) и Android.
- [ ] `ALLOWED_ORIGIN` ограничен адресом фронтенда.
- [ ] Свой TURN работает (`relay OK`), секрет не в git; старые пароли TURN-сервисов сменены.
- [ ] Платный тариф или keep-alive; `/health` отвечает.
- [ ] `STRICT_ROSTER=1`, когда клиенты обновлены.
- [ ] CI зелёный (`.github/workflows/ci.yml`), версии `VERSION`/`APP_VERSION`/`CACHE_VERSION` согласованы.
- [ ] Заполнены контакты и даты в [PRIVACY.md](PRIVACY.md) и [TERMS.md](TERMS.md), документы проверены юристом.
- [ ] Проверка устройства («Отладка → Проверка устройства») пройдена на iPhone и Android.
- [ ] Резервная копия и полное удаление проверены вручную.
- [ ] Лицензии звуков и иконок подтверждены ([THIRD_PARTY.md](THIRD_PARTY.md)).
