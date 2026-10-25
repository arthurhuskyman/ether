# Открытый протокол The Messenger (Ether), версия 1

Этот документ **выведен из кода**, а не наоборот: каждое поле и константа проверены по исходникам (`js/ratchet.js`, `js/crypto-helper.js`, `js/groupkeys.js`,
`js/channels.js`, `js/bigfile.js`, `js/signaling-client.js`, `signaling-server/*.js`). Если код и текст расходятся — прав код, а расхождение считается
ошибкой документа. Тестовые векторы из настоящего кода: `tests/vectors/protocol-v1.json` (генератор `tools/gen-protocol-vectors.js`, проверка `tests/protocol-v1.test.js`).
Референсная реализация клиента для Node: [`sdk/`](../sdk/README.md) (`ether-sdk`).

## 0. Статус и честные оговорки

- Протокол **не проходил независимый аудит** и **не верифицирован формально** (docs/AUDIT-PREP.md — подготовка к аудиту, а не его результат). Составлен из примитивов
  WebCrypto (ECDH P-256, ECDSA P-256, AES-256-GCM, HKDF/HMAC-SHA-256) и ML-KEM-768; конструкция Double Ratchet/X3DH — собственная реализация «по образцу» Signal,
  **не совместима** с Signal ни на проводе, ни по форматам.
- «Версия 1» — это состояние V.80. Старые клиенты (V.≤79) остаются совместимы: новые поля ничего не ломают, возможности согласуются битами и подсказками (§5.8).
- Сервер видит метаданные (кто с кем и когда обменивается конвертами, размер, IP-адреса), но не содержимое. Подробно: docs/THREAT-MODEL.md, docs/PRIVACY.md.
- Не входит в v1 (см. §14): sealed sender, вращающиеся идентификаторы, постквантовые подписи, формально описанная миграция.

## 1. Соглашения

- Все сообщения клиент↔сервер — JSON-объекты `{type: "...", ...}` в текстовых кадрах WebSocket; максимум кадра `MAX_PAYLOAD` = 8 МиБ. Неизвестный `type` игнорируется.
- Байты в JSON: `ct`, `iv`, подписи, `kem` — base64 **со стандартным алфавитом и `=`**; идентификаторы prekey и координаты JWK — base64url без `=`.
- Ключи: P-256, формат JWK `{kty:"EC", crv:"P-256", x, y[, d]}`. Долговременный ключ личности используется и для ECDH, и для ECDSA (подпись prekey).
- `from`/`to` в AAD — строковые id участников **как их видят стороны** (id ≤ 128 символов, без `#`; `#` зарезервирован для companion-устройств, docs/MULTIDEVICE.md).
- `‖` — конкатенация байтов, `|` — литеральный символ в строках домена. HKDF = HKDF-SHA-256, HMAC = HMAC-SHA-256.

## 2. Транспорт и сессия с сервером

1. Клиент открывает WebSocket и в течение `REGISTER_DEADLINE_MS` (15 с) шлёт `register`:
   `{type:"register", id, name, visible, publicKey: JWK, claim?, caps: ["env2","sk1"], watch?: [id…]}`; companion-устройство добавляет `deviceId` (docs/MULTIDEVICE.md).
2. `claim` = hex(SHA-256(`"ether-claim-v1|"` ‖ token)) (64 hex), token — случайный секрет устройства. Пока claim активен (`CLAIM_TTL_HOURS`, по умолчанию 336), id нельзя занять с другим claim:
   ответ `{type:"register-error", error:"id-claimed"}`. Сервер хранит только хэш от claim.
3. Ответ `{type:"registered", id, online:[{id,name,visible,publicKey,caps}], features:[…], prekeyCount, claimed, discoverySalt?}`. `features` — возможности сервера:
   `ratchet2 prekeys watch claim env2 devicelink devlist devmail devsync devpush devnotify alias channels gdeliver sk1 pq1 [discovery] [fed0]`. Клиент включает формат только если сервер его объявил
   (например, AAD v3 шлётся лишь при `pq1`: сервер без него вырежет поля `a`/`cp`).
4. Присутствие: `watch {ids}` заменяет список наблюдаемых (≤ 2000), ответ `watch-result {online, strict}`; изменения приходят как `presence {id, online, name, visible, publicKey, caps}`.
   Скрытый (`visible:false`) пользователь виден только тем, кто есть в его ростере; недоступность неотличима от офлайна (`unreachable`).
5. Живость: клиент шлёт `ping {t}` каждые 15 с (ответ `pong {t}`); без ping 60 с сервер закрывает сокет. Новое подключение того же id вытесняет старое (`replaced`).
6. Лимиты на стороне сервера (по умолчанию): 40 сокетов с IP, `signal` 120/мин, `deliver` 60/мин на пару и 1200/мин на отправителя, `prekey-fetch` 60/мин (12/мин на пару).
7. Алиасы миграции id: `alias-set {old, oldClaim}` → `alias-result {ok, ttlDays}`; 90 суток пересылка `deliver`/`signal` со старого id на новый.

## 3. Доставка конвертов (офлайн-почта)

```
→ {type:"deliver", to, msgId, envelope, fromPublicKey, kind, as?, copies?}
← {type:"deliver-ack", msgId[, error: "invalid-envelope"]}
сервер → получателю: {type:"deliver", from, msgId, envelope, fromPublicKey, kind, queued: bool}
получатель → {type:"mailbox-ack", msgId}   // подтверждение обработанного конверта; без него он остаётся в ящике и придёт снова
```

- `msgId` ≤ 128 символов, выбирает отправитель; повтор `(from,to,msgId)` с тем же конвертом идемпотентен. `kind` — `^[a-z0-9-]{1,24}$` (иначе `"chat"`): метка для сервера (push), **не** тип полезной нагрузки.
- Сервер хранит конверт в ящике получателя, пока тот не пришлёт `mailbox-ack` (потолки: `MAILBOX_MAX_PER_USER` 500, на отправителя 250, суммарные; TTL и персистентность — `MAILBOX_*`).
  Если получатель онлайн — пересылает сразу, но запись остаётся до `mailbox-ack`. Через 5 с без подтверждения для `kind:"chat"` уходит web-push «новое сообщение» (без содержимого).
- Сервер пропускает через `isValidEnvelope`/`cleanEnvelope` только известные поля конверта (§4.1, §5.1). `fromPublicKey` ≤ 1 КБ в JSON — публичный ключ отправителя (TOFU у получателя).
- `copies:[{dev, envelope}]` — копии для других устройств получателя/аккаунта (docs/MULTIDEVICE.md).
- Прямой канал WebRTC (DTLS) для сообщений, когда оба онлайн, в этот документ не входит; офлайн-конверты и P2P используют одну полезную нагрузку (§6).

## 4. Конверты «статический ECDH» (env v1/env2)

Формат `{iv, ct, v?}`: AES-256-GCM, ключ = результат ECDH(P-256) **как есть** (WebCrypto `deriveKey` → AES-GCM 256, без HKDF), IV 12 случайных байт.
`v:1` — без AAD (резервные копии и очень старые клиенты); `v:2` — AAD = UTF-8(`"ether-env-v2|"` ‖ fromId ‖ `"|"` ‖ toId), конверт нельзя подменить на обратное направление или другую пару.
Отсутствие HKDF и forward secrecy — известное ограничение; для сообщений используется Double Ratchet (§5), а env2 остался для приёма от старых клиентов и копий.
Получатель с `v > 2` отвечает ошибкой. Safety number: SHA-256 от канонических JWK (ключи объекта по алфавиту), сортируется пара строк, 12 групп по 5 цифр из первых 24 байт (§ вектор `safetyNumber`).

## 5. Double Ratchet (конверты `v:2` с полем `h`)

### 5.1 Формат

```json
{ "v": 2, "h": { "d": [x, y], "pn": 0, "n": 0, "i": 1, "p": { "e": [x, y], "s": "spkId", "o": "opkId|null", "v": 3, "k": "base64(ML-KEM ct)" }, "c": 7 },
  "ct": "base64", "a": 1|3, "rc": 1, "ac": 1, "cp": 7 }
```

`d` — текущий публичный ключ храповика отправителя; `pn` — длина предыдущей цепочки; `n` — номер в цепочке; `i:1` — «начальный» (пока нет ответа), `p` — prekey-заголовок (только вместе с `i`);
`c` — биты возможностей (только v3). `a` — уровень AAD (отсутствует = v1, `1` = v2, `3` = v3). `rc`, `ac`, `cp` — **неаутентифицированные подсказки** (§5.8).
Сервер при `v:2,h` сохраняет только `v,h.{d,pn,n,i,p,c},ct,a,ac,cp`, а `h.p.k` (если есть) обязан быть ровно 1452 символа base64 (1088 байт).

### 5.2 Примитивы

```
KDF_RK(rk, dhOut) = HKDF(ikm=dhOut, salt=rk, info="ether-dr-rk", L=64)  →  (rk' = [0..32), ck = [32..64))
KDF_CK(ck)        = (ck' = HMAC(ck, 0x02), mk = HMAC(ck, 0x01))
AEAD(mk)          = HKDF(ikm=mk, salt=32 нулевых байта, info="ether-dr-aead", L=44)  →  key = [0..32), iv = [32..44)   // AES-256-GCM
```

### 5.3 Старт сессии

Инициатор (A) → получатель (B); `ids` = `[idA, idB]`, отсортированные и склеённые `"|"`.

1. **От долговременных ключей** (нет prekey-пакета): `SK = HKDF(ikm=ECDH(IK_A, IK_B), salt="ether-dr-v1", info="ether-dr-init|"+ids, L=32)`.
   A: `dhs = новая пара`, `(rk, cks) = KDF_RK(SK, DH(dhs, IK_B))`, `dhr = IK_B`. B: `rk = SK`, `dhs = IK_B`, `dhr = null`. Заголовок без `p`.
2. **X3DH-подобный (классический)**: пакет B: `SPK` (подписанный) и необязательный одноразовый `OPK`. `parts = DH(IK_A,SPK_B) ‖ DH(EK_A,IK_B) ‖ DH(EK_A,SPK_B) [‖ DH(EK_A,OPK_B)]`,
   `SK = HKDF(ikm=parts, salt="ether-dr-x3dh-v1", info="ether-dr-x3dh|"+ids, L=32)`. A: `dhs = новая`, `(rk,cks) = KDF_RK(SK, DH(dhs, SPK_B))`, `dhr = SPK_B`; заголовок `p = {e: EK_A.pub, s: SPK.id, o: OPK.id|null}`.
   B: `rk = SK`, `dhs = SPK_B (пара)`, одноразовый OPK удаляется до выдачи открытого текста.
3. **v3 (+ гибридный ML-KEM-768)**: как (2), но в `parts` добавляется `ss` KEM, если пакет B содержит проверенный `kem` и `PQ1` разрешён; salt `"ether-dr-x3dh-v3"`,
   `info = "ether-dr-x3dh3|" + ids + "|" + bind`, где `bind = "v3|" caps "|" EK.x "." EK.y "|" spkId "|" (opkId|"") "|" b64(SHA-256(kemPub))|"" "|" b64(SHA-256(kemCt))|""`, `caps` — `LOCAL_CAPS` инициатора (получатель берёт `h.c`).
   Заголовок `p` дополняется `v:3` и `k` = base64(шифртекст KEM). Любая правка заголовка в пути меняет `SK` и AAD — расшифровка не удаётся (тихого понижения нет).

### 5.4 Шифрование сообщения

`(ck', mk) = KDF_CK(cks)`; `h = {d: dhs.pub, pn, n: ns}`; `ns++`; пока нет ответа добавляются `i:1` и `p`; для v3 `h.c = LOCAL_CAPS` (7).
Открытый текст — `JSON.stringify(payload)` (§6): для v1/v2 — UTF-8, для v3 — кадр `[0x03][caps][len uint32 BE][JSON][нули до корзины]`.
Корзины выравнивания (при `PAD1` у получателя): 256, 1024, 4096, 16384, затем кратно 65536; не дополняется, если кадр > 2 МиБ. Получатель обязан проверить, что `frame.caps == h.c` и хвост — нули.
`ct = AES-256-GCM(key, iv, AAD, plaintext)` (тег 16 байт в конце).

### 5.5 AAD (to = id получателя, from = id отправителя)

```
v1: "ether-dr1|from|to|d.x|d.y|pn|n"
v2: "ether-dr2|from|to|d.x|d.y|pn|n|i(0|1)|px"          px = "-" | "p,"+e.x+"."+e.y+","+s+","+o
v3: "ether-dr3|from|to|d.x|d.y|pn|n|i(0|1)|px|c"         px = "-" | "p,"+e.x+"."+e.y+","+s+","+o+","+k+","+v ;  c = h.c или -1
```

(`o`, `k`, `v` — пустая строка, если полей нет.) v1 не защищает `i`/`p` — поэтому v2/v3 отправляются только контактам, чья поддержка подтверждена (§5.8).

### 5.6 Приём

Сессии пробуются от новой к старой (≤ `MAX_SESSIONS` = 4). В сессии: если ключ `(d, n)` есть среди пропущенных — используется; иначе при смене `d` — вычисляются и сохраняются ключи до `pn` (шаг DH-храповика:
`(rk1, ckr) = KDF_RK(rk, DH(dhs, d))`, `dhs = новая`, `(rk2, cks) = KDF_RK(rk1, DH(dhs, d))`), затем до `n`. Пределы: `MAX_SKIP` = 200 за раз, 400 пропущенных ключей на сессию, `n < nr` — «duplicate or old».
Если ни одна сессия не подошла, а `h.i == 1` и `d` не из последних 8 известных (`HIST`) — создаётся ответная сессия по `p` (иначе от долговременных ключей). Повтор начального конверта отвергается (журнал `ri` ≤ 200 на контакт).
Запись состояния обязана удаться **до** выдачи открытого текста (иначе откат); при невозможности сохранить `encrypt` отказывается работать (защита от повторного использования ключа/IV).

### 5.7 Prekey-пакеты

- Загрузка: `prekey-upload {spk:{id, pub:[x,y], sig, sig2?, c?, kem?}, opks:[{id, pub}]}` → `prekey-stored {count}` или `{error:"invalid"}`. `id` — `[A-Za-z0-9_-]{1,32}`, ≤ 50 одноразовых за раз, ≤ 100 хранится, TTL записи 30 дней.
- Запрос: `prekey-fetch {to, rid}` → `prekey-bundle {rid, to, spk, opk}`; сервер **выдаёт и удаляет** один `opk`; при превышении лимита на цель выдаёт только `spk`. Владельцу при остатке < 10 приходит `prekey-low {count}`.
- `sig` = ECDSA-P256-SHA-256 (формат IEEE P1363, 64 байта, base64) долговременным ключом личности над UTF-8(`"ether-spk-v1|" id "|" x "|" y`).
  `sig2` — над `"ether-spk-v2|" id "|" x "|" y "|" c "|" kem`; `c` — маска возможностей, `kem` — base64 открытого ключа ML-KEM-768 (1184 байта → 1580 символов). Сервер хранит `sig2/c/kem` «всё или ничего».
- Клиент принимает расширение только под `sig2`; пакет без подписи принимается лишь от контактов, чей пакет ни разу не приходил подписанным (флаг `sg`); неверная подпись → старт от долговременных ключей.
- Ротация: `spk` раз в 7 суток (3 прежних живут для «хвостов»); локально ≤ 200 `opk`, живут ≤ 60 суток; закрытый ключ KEM-пары (seed, 64 байта) остаётся на устройстве.
- ML-KEM-768 (FIPS 203): нативный WebCrypto, если он есть и прошёл самопроверку против вшитой реализации `js/vendor/ml-kem768.js` (noble-post-quantum), иначе вшитая. KAT: `tests/vectors/mlkem768-kat.json`.

### 5.8 Возможности и «липкие» уровни

Биты: `A3 = 1` (AAD v3), `PQ1 = 2` (гибрид), `PAD1 = 4` (выравнивание); `LOCAL_CAPS = 7`. Источники знаний: **проверенные** — успешно расшифрованный конверт v3 (биты внутри шифртекста) и подписанный `sig2`-пакет;
**подсказки** — `ac`, `cp` и флаги `rc/e2` (не аутентифицированы, годятся только чтобы *попробовать* повысить уровень). Достигнутый проверенным конвертом уровень (`cv`) «липкий»: начальный конверт более слабого формата от этого контакта
отвергается (`downgrade`, предупреждение клиенту). Снять защиту может только явное решение человека (`resetTrust`). Сессии не переносятся в бэкап намеренно (откат состояния = повтор ключей).

## 6. Полезная нагрузка (внутри конверта)

JSON-объект с обязательным `kind`; неизвестный `kind` молча игнорируется. Базовое сообщение: `{kind:"chat", id, text, ts[, replyTo, groupId, senderName, ttl, forwarded]}`.
Другие виды (полный список — js/app/10-signaling.js): `edit`, `delete`, `reaction`, `file`, `sticker`, `story`, `poll/poll-vote/poll-close`, `board/board-op`, `note/note-op`, `contact-card`, `disappearing-timer`,
`group-admin`, `gk-dist`, `gk-req`, `group-join-request`, `id-migrate`, `rc-reset`, `heartbeat`, `miniapp` (§12). Время `ts` — время отправителя; приёмник ограничивает его (`clampOpTs`).
Группа до 8 участников — попарные конверты (`groupId` в нагрузке); больше — Sender Keys (§7).

## 7. Группы Sender Keys (`sk1`)

- Цепочка отправителя: `ck` (32 случайных байта), пара ECDSA P-256 для подписи, `cid`. Раздаётся каждому участнику по 1:1 E2E: `{kind:"gk-dist", id, groupId, cid, ck, n, spub:{x,y}}` (ck — текущее состояние, на `n`).
- Шаг: `mk = HMAC(ck,0x01)` (ключ AES-256-GCM), `ck' = HMAC(ck,0x02)`, `iv = HMAC(ck,0x03)[0..12)`. AAD = UTF-8(`"ether-sk1|" gid "|" sender "|" cid "|" n`).
  Подпись = ECDSA-P256-SHA-256 (P1363) над `AAD ‖ iv ‖ ct` ключом цепочки. Конверт `{v:"sk1", cid, n, iv, ct, sig}` (всё base64). Приёмник проверяет подпись **до** расшифровки и совпадение `iv` с выведенным.
- Пределы: пропуск ≤ 256 (хранится ≤ 512), ≤ 3 цепочки на отправителя; порог `SK_THRESHOLD` = 8 (больше — Sender Keys, только если *каждый* участник объявил `sk1`). Исключение участника → rekey у всех оставшихся.
- Сервер: `group-roster {gid, members, admins?, ver}` → `group-roster-ack {gid, ver | error: invalid|rate|not-admin|stale}` (реестр групп, `GROUP_MAX_MEMBERS` 256);
  `gdeliver {gid, msgId, to:[id…], envelope}` → `gdeliver-ack {msgId, live, queued, dropped | error: invalid|invalid-envelope|too-many|rate|not-member}`; получатели видят обычный `deliver` с `kind:"gchat"` и `gid`.

## 8. Каналы

Владелец создаёт пару ECDSA P-256 канала. Ссылка `#ch=<id>.<pubHash>[.<ключ канала, base64url 32 байта>]`; `id` = 16 hex (сервер: `^[a-z0-9]{12,32}$`),
`pubHash` = hex(SHA-256(`"ether-chpub|" x "|" y`))[0..26). Подписчик закрепляет хэш из ссылки и принимает ключ канала от сервера, только если хэш совпал.

Подписи (ECDSA-P256-SHA-256, P1363, base64) над UTF-8:
`ether-chmeta-v1|id|name|desc|enc(0|1)|ts|kv|av`, `ether-chpost-v1|id|postId|ts|enc|kv|iv|body`, `ether-chdel-v1|id|ts` (в `name/desc` символы `| \n \r` заменены пробелом, длины 60/200).
Закрытый канал: тело — base64 AES-256-GCM, AAD = `"ether-chenc-v1|" id "|" postId "|" kv`, IV 12 байт (`iv`); содержимое `{v:1, t, m?:{d,n}, r?}`; смена ключа = `kv+1` и новая ссылка.
Сообщения: `channel-create {ch, pub, meta, metaSig}` → `channel-created`; `channel-info`, `channel-subscribe` → `channel-info {pub, meta, metaSig, seq, subs, subscribed}`; `channel-unsubscribe`;
`channel-post {ch, post}` → `channel-post-ack {ch, id, seq | error}` и рассылка `channel-post {ch, seq, post}`; `channel-history {ch, since?, limit?}` → `channel-history {posts, seq, first}`;
`channel-meta` → `channel-meta-update`; `channel-delete` → `channel-gone`. Сервер проверяет подписи, допуск часов ±10 мин, дубликат поста идемпотентен. Лимиты: 20 каналов на владельца, 256 КБ пост, 20 постов/мин, история 200.

## 9. Звонок по ссылке (link-call)

Сообщения `linkcall-create/-join/-allow/-deny/-signal/-end` и ответы `linkcall-created {room, code, expiresAt}`, `-guest`, `-joined`, `-allowed`, `-denied`, `-error {reason}`, `-end`.
Комната: 128 бит base64url + 6-значный код; ссылка `#call=<room>.<k>`, секрет `k` (16 байт) — только во фрагменте; стороны обмениваются `HMAC(k, DTLS-отпечатки)` в SDP-данных.
Полная спецификация (тайминги, лимиты, SAS из 4 эмодзи = SHA-256(`"ether-lc-sas|"` ‖ отпечаток гостя)): **docs/CALL-RELIABILITY-PROTOCOL.md, раздел E и F**.

## 10. Серия «гудков» (push ring series)

Для офлайн-получателя `call-invite` (внутри `signal.data.t`) запускает серию web-push: #1 сразу, затем каждые 5 с, ≤ 6 (`RING_*`), пока звонок не принят/отклонён/отменён или не прошло 45 с.
Payload: `{t:"call-ring", callId, from, name, seq, total, video, ackToken}`, заголовки `Urgency: high`, `TTL: 30`, `Topic: ring-<callId[:8]>-<seq>`; отмена — `{t:"call-cancel", callId, reason}`.
`POST /push-ack {callId, seq, ackToken}` (токен = HMAC(секрет, callId|seq|хэш подписки), одноразовый) → звонящему `call-ringing {callId}`. Подробности и условия остановки: docs/CALL-RELIABILITY-PROTOCOL.md, разделы A–D.

## 11. Прямой канал WebRTC и передача файлов (`filebin1`)

- Сигнализация: `signal {to, data}` → получателю `signal {from, data}`; сервер ретранслирует непрозрачные SDP/ICE (`data.t` ∈ offer/answer/call-invite/…); недоступный адресат → `unreachable {to}`.
  Без сервера: код приглашения `"1" + ("1"|"0") + base64url(gzip?(JSON))` (≤ 8192 символов).
- На открытом DataChannel стороны шлют `{kind:"ping"|"pong", t, rc:1, e2:1, fb:1}`; `fb:1` = умею `filebin1`.
- JSON-сообщения: `file-meta {bin:1, id, name, mime, size, totalChunks, u:16384, h: sha256 hex, crc:0|1}`, `file-resume {id, ep, ranges}`, `file-end {id, ep}`, `file-ack {id, ep, n}`,
  `file-result {id, ok, reason?}`, `file-reject {id, reason}`, `file-pause {id}`, `file-cancel {id, reason}`. Размер ≤ 4 ГиБ.
- Двоичный кадр (один ArrayBuffer, big-endian): `[0xEB][ver=1][idLen][flags: bit0=crc] [u32 индекс первого блока][u32 длина][u32 crc32][id ASCII][данные]`.
  Блок = 16 КиБ; кадр несёт 1..15 блоков (по умолчанию 64 КиБ); `crc32` — IEEE (проверочное значение `crc32("123456789") = 0xCBF43926`). Целостность файла — SHA-256 из `file-meta.h`. Возобновление — по диапазонам блоков.
  Старый путь (`file-meta/file-chunk/file-done` с base64 в JSON, ≤ 2 МБ) остаётся для пиров без `fb`.

## 12. Расширения

- **Мини-приложения** (`kind:"miniapp"`): `{kind:"miniapp", id, ts, app, st}` — состояние встроенного приложения из реестра (`app`), `st` — JSON-объект ≤ 8000 символов. Манифест v1 и модель песочницы — в шапке `js/miniapps.js`
  (iframe `sandbox="allow-scripts"` без `allow-same-origin`, права `storage|sync|chat.post`, подтверждение каждого `chat.post`). Запуск чужих мини-приложений в v1 не поддержан (CSP).
- **Федерация ретрансляторов (fed0, ЭКСПЕРИМЕНТАЛЬНО, выключена)**: адрес `to:"id@пир"` в `deliver`; `POST /federation/inbox` с подписью Ed25519 закреплённым ключом пира. См. `signaling-server/federation.js` и SELF_HOSTING.md. Только непрозрачные конверты.
- **Несколько устройств**: docs/MULTIDEVICE.md. **Обнаружение по хэшу**: `discovery-publish/-lookup` (docs/PRIVACY.md).

## 13. Тестовые векторы

`tests/vectors/protocol-v1.json` (генерация детерминирована, кроме подписей ECDSA — они рандомизированы, и в файл попадает конкретная подпись, которую тест **проверяет**):

| раздел | что проверяется |
|---|---|
| `ratchet[]` | четыре сценария на настоящем `Ratchet`: старт от ключей личности (AAD v1 → v3), AAD v2, классический X3DH, v3 + ML-KEM с доставкой не по порядку; у каждого сообщения — `envelope`, ожидаемый `plain`, и (где нужно) `stateBefore` получателя |
| `prekeys` | загрузка `spk` с `sig/sig2/kem`, хранилище Боба; проверка подписей и их подмены |
| `env2`, `safetyNumber` | статический ECDH-конверт v1/v2 с AAD; 60-значный safety number |
| `senderKeys` | распределение цепочки, три конверта `sk1` (порядок доставки 1,0,2), отказы (`old`, `no-chain`, `bad-sig`) |
| `channels` | открытый и закрытый канал: мета, пост, подписи, ссылка `#ch=`, расшифровка ключом из ссылки |
| `filebin1`, `claim` | двоичный кадр с CRC и без, CRC32; доказательство владения id |

Запуск: `cd tests && node --test protocol-v1.test.js sdk.test.js`. Перегенерация: `node tools/gen-protocol-vectors.js` (флаг `--check` сверяет детерминированную часть). Независимая реализация (другой язык) считается совместимой,
если расшифровывает все `ratchet[].messages` по порядку `order` и проходит проверки остальных разделов. Вектор ML-KEM — отдельный файл `mlkem768-kat.json` (получен OpenSSL).

## 14. Версионирование и подготовка к v2 (что намечено, но НЕ сделано)

Расширяемость v1: биты `CAP`, поле `a` (уровень AAD), версия префикса prekey-заголовка `p.v`, `features` сервера, `caps` клиента, `v` конверта. Любое повышение формата обязано пройти путь «подсказка → проверенный уровень → липкость» (§5.8).
Кандидаты для v2 (исследование, решений нет): **sealed sender** (скрыть `from` от сервера; нужен механизм анонимного доступа к ящику и защиты от спама), **вращающиеся идентификаторы** (id ≠ долговременный публичный ключ, развязка по контактам),
постквантовые подписи (ML-DSA) для prekey и каналов вместо ECDSA, замена env2 (ECDH без HKDF) на HKDF-вывод, непрерывный PQ-храповик (сегодня гибрид только на старте сессии), формальная модель (Tamarin/ProVerif) и аудит.
До аудита и описания миграции v2 не объявляется, а v1 не заявляется как «неуязвимый».
