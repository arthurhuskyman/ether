"use strict";
// V.80.1: «Лаборатория звонка» (вкладка «Отладка») — чистая логика без DOM: ссылки sms:/tel:/FaceTime, .ics с VALARM,
// разбор UA, журнал экспериментов (PASS/FAIL/NOTES в localStorage, экспорт текстом), оценка фоновых замеров микрофона.
// Интерфейс — 20-ringlab-ui.js. Ничего из этого не включено в реальные звонки по умолчанию.
const RingLabCore = (() => {
  const LOG_KEY = "ether.ringlab.log";
  const LOG_MAX = 200;
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } };

  // ---- ссылки ----
  function cleanPhone(s) {
    const t = String(s || "").trim();
    const plus = t.charAt(0) === "+" ? "+" : "";
    const d = t.replace(/\D/g, "");
    return d.length >= 5 && d.length <= 15 ? plus + d : "";
  }
  function telLink(phone) { const p = cleanPhone(phone); return p ? "tel:" + p : ""; }
  // iOS ждёт «sms:<номер>&body=…», остальные «sms:<номер>?body=…»; без номера — выбор получателя в Сообщениях
  function smsLink(phone, body, ios) { return "sms:" + cleanPhone(phone) + (ios ? "&" : "?") + "body=" + encodeURIComponent(String(body || "")); }
  // FaceTime-ссылка: только https://facetime.apple.com/join#… (чужие схемы/хосты не открываем)
  function cleanFaceTimeLink(s) {
    const t = String(s || "").trim();
    try { const u = new URL(t); return u.protocol === "https:" && u.hostname === "facetime.apple.com" && t.length < 500 ? t : ""; } catch (e) { return ""; }
  }

  // ---- .ics с двумя будильниками (за 5 минут и в момент звонка) ----
  const pad = (n) => (n < 10 ? "0" : "") + n;
  function icsDate(ms) { const d = new Date(ms); return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + "T" + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + "Z"; }
  function icsEscape(s) { return String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n"); }
  function icsFold(line) { // строки ≤ 75 октетов UTF-8, продолжение начинается с пробела
    const out = []; let cur = "", bytes = 0;
    for (const ch of line) {
      const b = new TextEncoder().encode(ch).length;
      if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ""; bytes = 0; }
      cur += ch; bytes += b;
    }
    out.push(cur);
    return out.join("\r\n ");
  }
  function buildICS(o) {
    const start = o.start, now = o.now || Date.now();
    const title = o.title || "Test call", url = o.url || "", desc = (o.description || title) + (url ? "\n" + url : "");
    const alarm = (trig, text) => ["BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + icsEscape(text), "TRIGGER:" + trig, "END:VALARM"];
    const lines = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Ether//RingLab//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "BEGIN:VEVENT",
      "UID:" + (o.uid || "ringlab-" + now) + "@ether", "DTSTAMP:" + icsDate(now), "DTSTART:" + icsDate(start), "DTEND:" + icsDate(start + 15 * 60000),
      "SUMMARY:" + icsEscape(title), "DESCRIPTION:" + icsEscape(desc),
    ];
    if (url) lines.push("URL:" + url);
    lines.push(...alarm("-PT5M", title + " (5 min)"), ...alarm("PT0S", title), "END:VEVENT", "END:VCALENDAR");
    return lines.map(icsFold).join("\r\n") + "\r\n";
  }

  // ---- устройство ----
  function parseUA(ua) {
    ua = String(ua || "");
    const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && /Mobile\//.test(ua));
    const m = /OS (\d+)[_.](\d+)(?:[_.](\d+))?/.exec(ua);
    return { ios, version: ios && m ? m[1] + "." + m[2] + (m[3] ? "." + m[3] : "") : null, major: ios && m ? parseInt(m[1], 10) : null };
  }

  // ---- журнал ----
  function logRead() { try { const a = JSON.parse(lsGet(LOG_KEY) || "[]"); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function logAdd(id, res, note, now) {
    const a = logRead();
    a.push({ ts: now || Date.now(), id: String(id).slice(0, 40), res: ["PASS", "FAIL", "NOTE", "INFO"].indexOf(res) >= 0 ? res : "NOTE", note: String(note || "").slice(0, 1500) });
    while (a.length > LOG_MAX) a.shift();
    lsSet(LOG_KEY, JSON.stringify(a));
    return a;
  }
  function logClear() { lsSet(LOG_KEY, "[]"); }
  function exportText(header, entries) {
    const rows = (entries || logRead()).map((e) => new Date(e.ts).toISOString() + " [" + e.res + "] " + e.id + (e.note ? " — " + e.note.replace(/\s*\n\s*/g, " | ") : ""));
    return "Ether Ring Lab\n" + (header ? header + "\n" : "") + "----\n" + (rows.length ? rows.join("\n") : "(empty)") + "\n";
  }

  // ---- замеры микрофона в фоне ----
  // samples: [{t (мс от старта), hidden, tsr (totalSamplesReceived), tae (totalAudioEnergy)}]; vis: [{t, hidden}] смены видимости.
  function analyseMic(samples, vis) {
    const out = { samples: samples.length, hiddenMs: 0, bgSamples: 0, dSamples: 0, dEnergy: 0, flowed: null, note: "" };
    let hStart = null;
    for (const v of vis) { if (v.hidden) hStart = v.t; else if (hStart != null) { out.hiddenMs += v.t - hStart; hStart = null; } }
    if (hStart != null && samples.length) out.hiddenMs += samples[samples.length - 1].t - hStart;
    const bg = samples.filter((s) => s.hidden);
    out.bgSamples = bg.length;
    if (bg.length >= 2) { out.dSamples = bg[bg.length - 1].tsr - bg[0].tsr; out.dEnergy = bg[bg.length - 1].tae - bg[0].tae; }
    else if (out.hiddenMs > 0) { // таймеры в фоне заморожены: сравниваем последний замер до сворачивания и первый после возврата
      let before = null, after = null;
      for (const s of samples) { if (!s.hidden && s.t <= (vis.find((v) => v.hidden) || { t: 0 }).t + 1500) before = s; }
      const back = vis.filter((v) => !v.hidden).pop();
      if (back) after = samples.find((s) => s.t >= back.t);
      if (before && after) { out.dSamples = after.tsr - before.tsr; out.dEnergy = after.tae - before.tae; out.note = "timers-frozen"; }
    }
    const expected = (out.hiddenMs / 1000) * 48000;
    // 50% ожидаемых отсчётов И ненулевая энергия — звук шёл; иначе нет (энергия >0 требует, чтобы пользователь говорил/шумел)
    if (out.hiddenMs >= 2000 && (out.bgSamples >= 2 || out.note)) out.flowed = out.dSamples > expected * 0.5 && out.dEnergy > 0;
    return out;
  }

  return { cleanPhone, telLink, smsLink, cleanFaceTimeLink, icsDate, icsEscape, icsFold, buildICS, parseUA, logRead, logAdd, logClear, exportText, analyseMic, lsGet, lsSet, LOG_KEY };
})();
