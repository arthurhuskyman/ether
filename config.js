// Конфигурация развёртывания (грузится ДО бандлов; внешний файл, чтобы не менять CSP-хэши inline-скриптов).
// servers — встроенные серверы по умолчанию (первый = основной); mirrors — известные зеркала приложения.
// Зеркало на другом origin/сервере собирается так: node tools/make-mirror.js (см. docs/MIRRORS.md).
window.__ETHER_CONFIG__ = { servers: [{ url: "wss://ether-1-baqy.onrender.com", label: "Ether (основной)" }], mirrors: [] };
