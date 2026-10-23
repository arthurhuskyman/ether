# Построчный аудит V.76.1.0 — полный список дефектов

Источник: 7 read-only агентов (≈29 000 строк) + автоматические проверки. Все пункты получены от агентов; пункты, помеченные ✔, дополнительно перепроверены по трассировке. Статус всех: **не исправлено**.
Не читались целиком: js/skins/*.js (только register/deco), easter.js, emoji-data.js, languages-meta.js, linkauth.js, file-limits.js, crypto-helper.js, crypto-worker.js, rooms.js, lang/*.js.

Серьёзность: H — высокая, M — средняя, L — низкая. Фикс — одна строка-подсказка.

## 0. Автоматические проверки
| ID | Что | Фикс |
|---|---|---|
| T1 M | `tools/validate-languages.js`: в 70 языках нет 9 ключей (devicecheck.title, chat.menu.recentLast, chat.reactionsAria, devices.validUntil, devices.autoRenew, devices.backupCopy, devices.fileElsewhere, devices.fileRequest, …) | lang-missing + lang-merge, добавить проверку в CI |
| T2 L | Тест «Словари: все fx*/gcall* ключи…» падал в одном полном прогоне, при повторе зелёный — причина не найдена | найти источник нестабильности |

## 1. Сервер (signaling-server)
| ID | Sev | Место | Дефект → фикс |
|---|---|---|---|
| S1 ✔ | M | server.js:1361,1548,1640,1904; devices.js:24,116-121 | id вида `victim#<devId>` = ключ ящика companion: чтение метаданных, удаление, перехват push-подписки → запретить `#` в id и `to` |
| S2 | M | server.js:1673-1700 | push о звонке без canReach; 6-8 id занимают лимит 3/15 с → слать только при canReach, отдельный лимит |
| S3 | L | devicelink.js:63-83 | /link/put читает до 20 МБ до проверки заголовков → проверять X-Link-*, Content-Length, лимит параллельных |
| S4 | L | devicelink.js:88-95 | /link/init без квоты на IP в каналах → квота |
| S5 | L | devicelink.js:24,73 | globalFails не проверяется (мёртвый потолок) → применить или удалить |
| S6 | L | server.js:569-590 | гонка счётчика linkPreviewImageCacheBytes → вычитать байты старой записи, дедуп in-flight |
| S7 | L | server.js:36, guards.js:100-108 | TRUST_PROXY включён по умолчанию → выключить, описать в SELF_HOSTING.md |
| S8 | L | server.js:870-900 | saveMailbox: синхронный stringify до 400 МБ, ветка «только текст» недостижима и теряет не-chat → считать размер заранее, писать потоково |
| S9 | L | server.js:1873-1879 | discovery-publish: чужой phone-hash вытесняется → не перезаписывать активного владельца |

## 2. WebRTC / крипто
| ID | Sev | Место | Дефект → фикс |
|---|---|---|---|
| C1 | M | webrtc.js:497-500 | fingerprints() берёт первый a=fingerprint (нужен active MITM на сигналинге) → matchAll, при различии отклонять |
| C2 | M | signaling-client.js:410-418 | id = SHA-256 телефона без соли → перебор номеров → случайный id / HMAC с серверной солью. **Исправлено (миграция всех пользователей на id v2 = PBKDF2 600k, алиас на сервере 90 суток, подписанное уведомление контактам; см. README «Миграция id v1 → v2»)** |
| C3 | L | ratchet.js:106,165 | AAD не включает h.i и h.p → добавить |
| C4 | L | ratchet.js:295-300 | одноразовый opk удаляется в памяти, persist не гарантирован → не отдавать plaintext до записи |
| C5 | L | ratchet.js:329 | при OPK_STORE_MAX удаляются opk, которые сервер ещё раздаёт → удалять только подтверждённые |
| C6 | L | group-call.js:221-235 | gcallToggleCamera без защиты от двойного нажатия → флаг camBusy |
| C7 | L | webrtc.js:1208-1217 | setMuted: общий 10-с таймаут гасит страховку следующего mute → хранить id |
| C8 | L | webrtc.js:946-968 | _ensureLocalAudio/_addAudioTrackOnce без in-flight promise → микрофон может остаться включённым → кэшировать promise |

## 3. Клиент js/app/01–05
| ID | Sev | Место | Дефект → фикс |
|---|---|---|---|
| A1 | M | 05:1146-1147 | openGroupInfo: `style.background=""` стирает фото группы → убрать |
| A2 | M | 04:844-849, sw.js:107 | первая установка SW → controllerchange → reload, теряется онбординг → hadController |
| A3 | M | 04:778-786, 10:1145-1154 | Dead Man's Switch: нет «выключено», получатель получает ложные тосты вечно → heartbeat off |
| A4 | M-L | 01:147-221, 14:740 | dbPromise кэшируется после reject/close; нет tx.onabort; restoreFromIDB без таймаута → сброс, onclose, Promise.race 3 с |
| A5 | M-L | 05:19-24,133-155 | битый JSON contacts → следующая запись затирает пустым списком → сохранить сырое в IDB, не перезаписывать |
| A6 | L | 05:651-659 | #add= добавляет контакт молча → confirmSheet |
| A7 | L | 05:1097 | charAt(0) режет суррогаты в индексе → Array.from |
| A8 | L | 05:1009-1010 | pointercancel переставляет закреп → отдельный cancel-обработчик |
| A9 | L | 02:427-437 | плейсхолдер \u0000CODE → вырезать NUL из входа |
| A10 | L | 04:536-565 | maybeOfferSystemLanguage дважды → дубли обработчиков → флаг |
| A11 | L | 05:585 | c.members.length для группы без members → TypeError, чаты не рисуются → `(c.members||[])` |
| A12 | L | 02:613-625 | highlightRaw: сдвиг для символов с изменением длины при toLowerCase («İ») |
| A13 | L | 04:598-607 | lockViewportGestures глотит быстрый второй тап по кнопкам → только для не-интерактивных |

## 4. Клиент js/app/06–09
| ID | Sev | Место | Дефект → фикс |
|---|---|---|---|
| B1 | M | 08:453-641, 369 | запись голосового без лимита: ≈175 с (группа ≈87 с) и запись теряется → автостоп и предупреждение |
| B2 | M | 07:216-232 | удалённое неотправленное остаётся в outbox/pendingNoKey и доходит до собеседника → чистить (для групп через groupDeliveryMap) |
| B3 | M | 07:929-941 | таймер исчезновения в группе уходит в pendingNoKey → dispatchRich или скрыть пункт |
| B4 | M | 09:347-361,403 | forwardContact не умеет группу; пересылка заблокированному не проверяется → фильтр blocked, ветка группы |
| B5 | M | 09:105, 10:990 | ростер без createdBy → участник становится создателем/админом → принимать от админа |
| B6 | L-M | 06:55-65, 07:876-886 | подпись ленты не зависит от contacts: кнопка «Добавить» не обновляется → учесть contacts.has |
| B7 | L-M | 08:1344-1348 | ttl считается от read; без квитанций хранится 30 сут → считать от delivered |
| B8 | L | 06:883 | Ctrl+K на русской раскладке → e.code==="KeyK" |
| B9 | L | 08:1317 | Enter при IME в Safari (keyCode 229) отправляет → проверка 229 |
| B10 | L | 09:46 | isMentioned для не-латиницы → `(?![\p{L}\p{N}_])` |
| B11 | L | 08:634-640 | recorder.stop() на inactive → голосовое не уходит → собрать из chunksSnapshot |
| B12 | L | 07:461,516 | таймер истории не возобновляется на blur |
| B13 | L | 09:486, webrtc.js:689-694 | sendFile без fwdFrom/ttl |
| B14 | L | 08:1291-1299, 07:34-39, 06:824 | блобы sticker.custom не чистятся при очистке/trim |
| B15 | L | 09:247 | прозрачный PNG → чёрный аватар → белая подложка |
| B16 | L | 08:943,1143 | href="#" у документа меняет hash (читается для инвайтов) → preventDefault |

## 5. Клиент js/app/10–14
| ID | Sev | Место | Дефект → фикс |
|---|---|---|---|
| D1 ✔ | M | 13:794-798, 11:869-873, 12:115 | прямой `state.chatId=id` без closeChatSafely: replyTo/editingMessageId остаются → цитата из чата A уходит в B → общая функция сброса при смене chatId |
| D2 | M | 11:53-60 | startQrScan: закрытие шторки до getUserMedia → камера остаётся, QR добавит контакт без UI → токен запуска |
| D3 | L-M | 10:351-362 | call-invite без gcallBusy() → экран поверх группового звонка → call-busy |
| D4 | L-M | 13:467-548 | pinSave без busy-флага → два параллельных rekey |
| D5 | L | 13:346-357 | смена id без Ratchet.resetAll()/envelopeCache.clear() |
| D6 | L | 10:298,1379 | имя из presence без slice(0,40) |
| D7 | L | 11:419-420 | handleIncomingCode молча возвращается при ошибке/не-offer → toast badInviteCode |
| D8 | L | 11:395-416 | createInvite без защиты от повторного вызова |
| D9 | L | 11:497 | confirmSheet перезаписывает resolve, первый промис висит → резолвить false |
| D10 | L | 14:230,240-244 | applyImportedData: частичное применение, сырой e.message без i18n → снимок и откат |
| D11 | L | 13:1253 | clearOldMedia не чистит fileBlobUrlCache/voiceAudioCache |
| D12 | L | 13:104 | цикл тем без "oled" |
| D13 | L | 10:1152-1153 | heartbeat ts/thresholdDays без валидации |
| D14 | L | 12:826 | голосовая почта предлагается после локальной ошибки микрофона |

## 6. Прочие модули, SW, index.html
| ID | Sev | Место | Дефект → фикс |
|---|---|---|---|
| M1 | M | sw.js:104, tests/hardening-features.test.js:114 | activate удаляет transformers-cache → Whisper качается после каждого релиза → удалять только `ether-shell-*` кроме текущего, поправить тест |
| M2 | M | stickers.js:327 | S.prepare только image/webp; Safari даёт PNG → сломан «Добавить стикер» на iOS → принимать S.MIMES |
| M3 | L-M | sw.js:160-172 | SWR cache.put для SHELL_FILES подменяет код текущего кэша новым → не писать для SHELL_FILES |
| M4 | L | sw.js:160-172 | Range-запросы (audio) отдаются 200 вместо 206 — возможна проблема звуков на iOS (не проверено) → поддержать Range |
| M5 | L | devices.js:67-89 | refreshPeer: гонка read-modify-write K_PEERS → noteNewDevices подавляется |
| M6 | L | devices.js:297-310 | renewDue без мьютекса → два списка с одним seq |
| M7 | L | devices.js:10,337 | K_REVOKED пишется, не читается |
| M8 | L | stickers.js:382-402 | render() без токена поколения |

## 7. CSS и скины
| ID | Sev | Место | Дефект → фикс |
|---|---|---|---|
| K1 | H | styles.css:1085-1098,2038; skins.css:34; newyear.css:95 | physical + logical радиусы пузыря одновременно → в RTL оба нижних угла острые → только логические |
| K2 | H | cartoon:74-81, comic:86, chalk:97, glass:87, clay:114 | физические хвосты, нет RTL → inset-inline-* |
| K3 | H | gothic:208, steampunk:202, chalk:155, wood:239,241 | псевдоэлементы внутри :is() невалидны → анимации не гасятся при reduced-motion → отдельные селекторы |
| K4 | H | lego.css:140 + skins.css:80 | имя отправителя 1.59:1 (dark) |
| K5 | H | lego.css:191 vs skins.css:80 | «Удалить» 1.78:1 (lego dark), wood dark ≈3.2:1 |
| K6 | H | steampunk.css:74-85 | подписи таб-бара 2.0-3.5:1, «Offline» ≈2.1:1 |
| K7 | M | z-index: #toast 1000 vs gcall/story 1200-2552, fx-* 1100-1300, lang-offer 500/update-banner 600 над .sheet 70 | единая шкала z-index, тост выше всех |
| K8 | M | styles.css:1501-1603 | белый на accent 3.68:1 (dark), aurora 2.16:1, danger 3.41:1 → `--on-accent` |
| K9 | M | styles.css:424,667,523,882 | success/warning как текст в light 2.7-3.1:1 → text-варианты токенов |
| K10 | M | glass.css:104 | destructive 2.5:1 |
| K11 | M | neon.css:182,184; cartoon.css:114 | белый на розовом 3.2/3.05:1 |
| K12 | M | glass.css:60 | padding перебивает safe-area-inset-bottom (iPhone); kb-open не работает в chalk/clay/lego/glass |
| K13 | M | styles.css:1675 | mini-call-bar bottom захардкожен, скины меняют высоту таб-бара → `--tabbar-h` |
| K14 | M | styles.css:2596,2463,2614 | min-width голосовых/опросов/заметок шире пузыря на 320-380 px → `min(250px,100%)` |
| K15 | M | wood/gothic/neon/comic.css (list в отчёте) | decorative outline/clip-path скрывают focus-ring → box-shadow / outline-offset:-2px |
| K16 | M | styles.css:1400,243,723,782,1729 | outline:none без замены на полях ввода |
| K17 | M | styles.css:1817-1821 | reduced-motion без animation-iteration-count:1; .ptr-spinner перебит |
| K18 | L | styles.css:1011,1142,2347,902,266,919 | физические margin/padding → логические (RTL) |
| K19 | L | styles.css:2335 vs 1053 | user-select:none перебивает text в пузыре — намеренно? |
| K20 | L | styles.css | дубли: .chat-filters (548,2329,2392), #nav-bar (310,2328), .board-card ×5, .voice-bubble min-width ×3, .call-video-overlays ×2, chip min-height |
| K21 | L | styles.css:15,525; comic.css:116; skins.css | мёртвые селекторы .contact-row, .chat-row-fail-icon, .send-btn-wrap, .glass-regular |
| K22 | L | js/skins.js:9-21 | превью/theme-color не совпадают с CSS (lego, chalk, comic, neon, wood, steampunk); aurora не учтена в syncMeta |
| K23 | L | cartoon/lego/wood/clay/default | вторичный текст/accent 4.33-4.49:1 → затемнить на 3-5% |
| K24 | L | скриншоты | подсказка «Свайп вправо…» перекрывает поле ввода/список в cartoon, comic, neon, steampunk, gothic (проверить на реальном устройстве) |
