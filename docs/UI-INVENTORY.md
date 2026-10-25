# Инвентарь интерфейса (V.80) и устранённые дубли

Снято скриптом в jsdom (обход экранов, шторок и динамических меню) + чтение index.html / js/app/*.js. Формат: экран -> пункты (handler / i18n).

| Экран / меню | Пункты (id или действие; i18n-ключ) |
|---|---|
| Шапка списка | глобальный поиск `#global-search-btn` (search.global.title); Ctrl+K палитра `#cmdk` |
| Вкладки | Talk / Contacts / Settings / Debug (`data-tab`) |
| Чаты | фильтры All/Unread/Groups/Direct/Calls + папки; строка: свайп Archive/Mute/Pin/Delete; долгое нажатие `openChatRowMenu`: Pin, Mute, Folder, Mark unread, Archive |
| Шапка чата | назад, `#chat-peer-tap` (карточка), поиск, звонок, видео, `⋯` `openChatHeaderMenu`: Media (карточка), Mute, Disappearing, Chat summary, Clear history |
| Меню «+» (композер) | Last attachment, Emoji, Camera, File, Poll, Task, Note, Stickers, More (chat.menu.*) |
| Меню сообщения `openMessageSheet` | реакции; Reply, Forward, Copy, Pin; Translate, Favorite, Task, Remind, Thread, (Summary), Select, Edit, Delete local/both |
| Карточка контакта | Message, Call, Look; Chat settings: Disappearing, Sound, Rename, Mute, Vibrate, Pin, Archive, Block, Reset protection, Export, Summary, Forward, Verify; fx: signed export, poster, wall, replay; Danger: Clear, Delete |
| Инфо группы | аватар, имя, описание, Call, Voice room, write-restricted, Invite link, участники (Make admin / Remove), «Дополнительно» (slow mode, pin policy, join approval, reason, moderator, Remove, Transfer, banned, pending), Add member, Leave |
| Подключение | Join by code, New group, New channel, имя/значение + Find by phone + Add contact, My QR, Scan QR, ручное подключение (invite/answer) |
| Настройки: плитки | Theme, Skin, Sounds, Notifications, PIN, Backup, Simple mode (ярлыки на строки ниже) |
| Настройки: категории | Profile (имя, id, about, sigil, Help), Privacy (Servers, Host own server, Security, видимость, квитанции, last seen, presence, discovery, Blocked, Dead man), Notifications & security (notif, verified-only, hide IP, call report, previews, translate, sounds, quiet, ringtone, PIN, encrypt), Appearance (theme, text size, skins, readable, calm, bubbles, wallpaper, эффекты fx/fx2), Data & backup (Local AI, Export/Import, Move device, My devices, Delete account), Help & about |
| Debug | Diagnostics, WebRTC, TURN, Event log, Storage, Export diagnostics, Device check, Report, Drop connections, Hide tab |
| Звонок | mute, speaker, video, more (screen share), draw, end; accept/decline (код звонков правит другой агент, не менялось) |

## Найденные дубли и решения

| # | Дубль | Решение |
|---|---|---|
| 1 | Меню `⋯` чата: «Search in chat» дублировал значок поиска в шапке | убрано из меню |
| 2 | `⋯`: «Pinned message» дублировал баннер закреплённого | убрано |
| 3 | `⋯`: «Export chat» дублировал карточку контакта | убрано (есть в карточке) |
| 4 | «Chat summary» в трёх местах (меню «+», `⋯`, карточка); в «+» это не вложение | убрано из «+» (`#chat-summary-btn`); оставлены `⋯` и карточка |
| 5 | Debug: «Export all data / Import data» = строки в Настройках > Data | убраны из Debug |
| 6 | Debug: «Full app reset» = «Delete account» в настройках (одна функция `performFullAccountWipe`) | убрано из Debug |
| 7 | Настройки: поле «Connection server» + «Servers» (список) управляли одним и тем же | поле скрыто, показывается только пока в нём остался старый адрес; вход один — «Servers» |
| 8 | Контакты, пустое состояние: «Scan QR» / «Add by ID» вызывали кнопки, видимые на том же экране | убраны |
| 9 | Инфо группы: у участника ✕ «Remove from group» и «Remove» (с причиной) в «Дополнительно» | ✕ скрыт, когда доступно «Remove» с причиной |

Оставлено сознательно (естественные ярлыки): плитки настроек = строки категорий; свайп = долгое нажатие в списке чатов; Mute / Disappearing / Clear в `⋯` и в карточке контакта; «Media» в `⋯` открывает карточку (как нажатие на имя); фильтр «Calls» и вкладка звонков.
Не дубли: «Calm mode» и пресет эффектов «Calm» (пресет сам переключает calmMode); «Advanced» по категориям (одна кнопка на активную категорию).
Повторные отрисовки: все вставляемые строки (fx/fx2/presets, admin-панель группы, карточка) защищены id-проверками; проверено тестом `tests/fix80-menu-dedup.test.js`.
Замечание: «Report a problem» в Debug без i18n-ключа (не менялось).
