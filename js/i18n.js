/**
 * i18n.js — движок интернационализации для Ether.
 * Зависит от languages.js (глобальный объект window.LANGUAGES / global.LANGUAGES).
 *
 * Публичный API (используется в app.js):
 *   T(key, params)               — глобальная функция перевода
 *   I18N.t(key, params)          — то же самое
 *   I18N.init(preferredCode)     — инициализация (авто-детект языка системы)
 *   I18N.setLanguage(code)       — смена языка (+ авто-применение dir="rtl")
 *   I18N.setLang(code)           — алиас для setLanguage
 *   I18N.getLanguage()           — текущий код
 *   I18N.current                 — геттер, текущий код (для app.js)
 *   I18N.applyLanguage(code)     — применить язык к DOM
 *   I18N.detectSystemLanguage()  — определить язык системы
 *   I18N.systemLang()            — нормализованный код языка системы (диагностика)
 *   I18N.getLanguages()          — массив { code, name, english, native, rtl }
 *   I18N.languages               — геттер, то же самое
 *   I18N.nativeName(code)        — нативное имя языка
 *   I18N.shouldOfferSystem()     — предложить ли смену языка (или null)
 *   I18N.markOfferShown()        — пометить, что предложение уже показано
 *   I18N.isRTL(code)             — RTL ли язык
 *   I18N.onLanguageChange(fn)    — подписка на смену языка
 */
(function (global) {
  "use strict";

  const STORAGE_KEY = "ether.lang";
  const OFFER_KEY = "ether.langOffered";
  const DEFAULT_LANG = "en";

  // RTL-языки: при переключении автоматически ставится <html dir="rtl">
  const RTL_LANGS = ["ar", "fa", "ur", "he"];

  const listeners = new Set();

  const registry =
    (global.LANGUAGES && typeof global.LANGUAGES === "object") ? global.LANGUAGES : null;

  if (!registry) {
    console.error("[i18n] LANGUAGES не найден. Подключите languages.js перед i18n.js.");
  }

  let current = DEFAULT_LANG;

  // ---------- служебное ----------
  function isSupported(code) {
    return !!(registry && code && Object.prototype.hasOwnProperty.call(registry, code));
  }

  function normalize(code) {
    if (!code) return null;
    return String(code).toLowerCase().replace(/_/g, "-").split("-")[0];
  }

  function isRTL(code) {
    const c = normalize(code);
    if (RTL_LANGS.indexOf(c) !== -1) return true;
    return !!(registry && registry[c] && registry[c].rtl);
  }

  function dictFor(code) {
    const entry = registry && registry[code];
    if (entry && entry.dict) return entry.dict;
    const fallback = registry && registry[DEFAULT_LANG];
    return (fallback && fallback.dict) || {};
  }

  // ---------- определение языка системы ----------
  function detectSystemLanguage() {
    const candidates = [];
    if (typeof navigator !== "undefined") {
      if (Array.isArray(navigator.languages)) candidates.push.apply(candidates, navigator.languages);
      if (navigator.language) candidates.push(navigator.language);
      if (navigator.userLanguage) candidates.push(navigator.userLanguage);
    }
    for (let i = 0; i < candidates.length; i++) {
      const code = normalize(candidates[i]);
      if (isSupported(code)) return code;
    }
    return DEFAULT_LANG;
  }

  // Язык системы как он есть (даже если не поддерживается) — для диагностики.
  function systemLangRaw() {
    if (typeof navigator !== "undefined") {
      const raw = (Array.isArray(navigator.languages) && navigator.languages[0])
        || navigator.language || navigator.userLanguage;
      const code = normalize(raw);
      if (code) return code;
    }
    return DEFAULT_LANG;
  }

  // ---------- перевод ----------
  function interpolate(template, params) {
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, function (_, key) {
      return Object.prototype.hasOwnProperty.call(params, key)
        ? String(params[key])
        : "{" + key + "}";
    });
  }

  function t(key, params) {
    const primary = dictFor(current);
    const fallback = dictFor(DEFAULT_LANG);
    let text = primary[key];
    if (typeof text !== "string") text = fallback[key];
    if (typeof text !== "string") return key;
    return interpolate(text, params);
  }

  // ---------- применение языка к DOM ----------
  function applyLanguage(code) {
    const lang = isSupported(code) ? code : DEFAULT_LANG;
    current = lang;

    if (typeof document !== "undefined" && document.documentElement) {
      const html = document.documentElement;
      html.setAttribute("lang", lang);
      // АВТО-ПЕРЕКЛЮЧЕНИЕ НАПРАВЛЕНИЯ:
      //   ar / fa / ur / he  →  dir="rtl"
      //   все остальные       →  dir="ltr"
      html.setAttribute("dir", isRTL(lang) ? "rtl" : "ltr");
    }

    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(STORAGE_KEY, lang);
      }
    } catch (e) { /* localStorage может быть отключён */ }

    listeners.forEach(function (fn) {
      try { fn(lang); } catch (e) { console.error("[i18n] listener error:", e); }
    });
  }

  function setLanguage(code) { applyLanguage(code); }
  function getLanguage()     { return current; }

  function onLanguageChange(fn) {
    if (typeof fn === "function") listeners.add(fn);
    return function unsubscribe() { listeners.delete(fn); };
  }

  // ---------- инициализация ----------
  function init(preferredCode) {
    let saved = null;
    try {
      if (typeof localStorage !== "undefined") saved = localStorage.getItem(STORAGE_KEY);
    } catch (e) {}

    const initial =
      (isSupported(preferredCode) && preferredCode) ||
      (isSupported(saved) && saved) ||
      detectSystemLanguage();

    applyLanguage(initial);
    return current;
  }

  // ---------- список языков для UI ----------
  function getLanguages() {
    if (!registry) return [];
    return Object.keys(registry).map(function (code) {
      const entry = registry[code];
      return {
        code: code,
        name: entry.name,          // English-имя (напр. "Russian")
        english: entry.name,       // алиас для app.js
        native: entry.native,      // нативное имя (напр. "Русский")
        rtl: !!(entry.rtl || isRTL(code)),
      };
    });
  }

  function nativeName(code) {
    const c = normalize(code);
    if (registry && registry[c] && registry[c].native) return registry[c].native;
    if (registry && registry[DEFAULT_LANG]) return registry[DEFAULT_LANG].native;
    return "English";
  }

  // ---------- предложение сменить язык ----------
  function shouldOfferSystem() {
    let offered = false;
    try {
      if (typeof localStorage !== "undefined") {
        offered = localStorage.getItem(OFFER_KEY) === "1";
      }
    } catch (e) {}
    if (offered) return null;
    const sys = detectSystemLanguage();
    if (!sys || sys === current) return null;
    if (!isSupported(sys)) return null;
    return sys;
  }

  function markOfferShown() {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(OFFER_KEY, "1");
      }
    } catch (e) {}
  }

  // ---------- публичный API ----------
  const I18N = {
    t: t,
    init: init,
    setLanguage: setLanguage,
    setLang: setLanguage,          // alias для app.js
    getLanguage: getLanguage,
    applyLanguage: applyLanguage,
    detectSystemLanguage: detectSystemLanguage,
    systemLang: systemLangRaw,
    isRTL: isRTL,
    getLanguages: getLanguages,
    nativeName: nativeName,
    shouldOfferSystem: shouldOfferSystem,
    markOfferShown: markOfferShown,
    onLanguageChange: onLanguageChange,
    RTL_LANGS: RTL_LANGS.slice(),
    STORAGE_KEY: STORAGE_KEY,
    OFFER_KEY: OFFER_KEY,
    // Динамические геттеры для совместимости с app.js
    get current()   { return current; },
    get languages() { return getLanguages(); },
  };

  // Глобальная функция T() — короткий алиас, используется по всему app.js
  global.T = function (key, params) { return t(key, params); };

  if (typeof module !== "undefined" && module.exports) module.exports = I18N;
  global.I18N = I18N;
})(typeof window !== "undefined" ? window : globalThis);