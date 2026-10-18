"use strict";
// discovery.js — добровольный поиск знакомых по хэшу телефона/почты (по умолчанию ВЫКЛ).
// Ключ обнаружения = HMAC-SHA256(соль сервера, нормализованный телефон/email). Сервер видит только хэш, id и публичный ключ.
// Нормализация — та же, что у Identity (email: trim + lower-case; телефон: только цифры с «+», код страны обязателен, 7–15 цифр).
// Найденный контакт проверяется: id из ответа должен совпасть с id, посчитанным локально из введённого номера/почты (Identity.hashId),
// поэтому сервер не может подсунуть чужой id под известный номер; публичный ключ дальше подтверждается номером безопасности, как у любого контакта.
const Discovery = (() => {
  const BATCH = 200;
  const hex = (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  async function hmac(salt, normalized) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(String(salt)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return hex(await crypto.subtle.sign("HMAC", key, enc.encode(String(normalized))));
  }
  // Телефон/почта → { raw, normalized, id, hash } либо null (невалидно). Дубликаты схлопываются в prepare().
  async function prepareOne(raw, salt) {
    let ident;
    try { ident = await Identity.idFor(raw); } catch (e) { return null; }
    return { raw: String(raw).trim(), normalized: ident.normalized, type: ident.type, id: ident.id, hash: await hmac(salt, ident.normalized) };
  }
  async function prepare(rawList, salt) {
    const seen = new Set(), out = [];
    for (const r of rawList || []) {
      const it = await prepareOne(r, salt);
      if (!it || seen.has(it.hash)) continue;
      seen.add(it.hash); out.push(it);
    }
    return out;
  }
  // Строки из многострочного поля: делим по переводам строк, запятым и точкам с запятой (email не содержит ни того, ни другого)
  function splitInput(text) { return String(text || "").split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean).slice(0, 1000); }
  function cleanName(n) { return typeof n === "string" ? n.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, "").trim().slice(0, 60) : ""; }
  // Оставляем только ответы, которые совпали с запросом по хэшу и по id; имя чистим (в UI оно всё равно идёт через textContent/escapeHtml)
  function verify(found, prepared) {
    const byHash = new Map(prepared.map((p) => [p.hash, p]));
    const out = [], seen = new Set();
    for (const f of Array.isArray(found) ? found : []) {
      if (!f || typeof f.hash !== "string" || typeof f.id !== "string") continue;
      const p = byHash.get(f.hash);
      if (!p || p.id !== f.id || seen.has(f.id)) continue;
      if (!f.publicKey || typeof f.publicKey !== "object" || Array.isArray(f.publicKey)) continue;
      seen.add(f.id);
      out.push({ id: f.id, hash: f.hash, publicKey: f.publicKey, name: cleanName(f.name), raw: p.raw, normalized: p.normalized });
    }
    return out;
  }
  // Запрос к серверу пачками ≤200. Возвращает { found, error } (error — "rate"/"timeout"/… при неудаче; уже найденное сохраняется).
  async function lookup(sig, prepared, opts) {
    const timeoutMs = (opts && opts.timeoutMs) || 8000;
    const found = [];
    let error = null;
    for (let i = 0; i < prepared.length && !error; i += BATCH) {
      const chunk = prepared.slice(i, i + BATCH);
      const rid = "d" + Math.random().toString(36).slice(2, 12);
      const res = await new Promise((resolve) => {
        const done = (v) => { clearTimeout(t); sig.removeEventListener("discovery-result", h); resolve(v); };
        const h = (ev) => { if (ev.detail && ev.detail.rid === rid) done(ev.detail); };
        const t = setTimeout(() => done({ found: [], error: "timeout" }), timeoutMs);
        sig.addEventListener("discovery-result", h);
        if (!sig.discoveryLookup(rid, chunk.map((p) => p.hash))) done({ found: [], error: "offline" });
      });
      if (res.error) error = res.error;
      found.push(...verify(res.found, chunk));
    }
    return { found, error };
  }
  function supported(sig) { return !!(sig && sig.connected && sig.registered && Array.isArray(sig.features) && sig.features.includes("discovery") && sig.discoverySalt); }
  return { BATCH, hmac, prepare, prepareOne, splitInput, verify, lookup, supported, cleanName };
})();
if (typeof window !== "undefined") window.Discovery = Discovery;
