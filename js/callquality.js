// Качество звонков: чистые функции без обращения к DOM/WebRTC (тестируются в Node, см. tests/fix80-callquality-*.test.js).
//  - tuneOpusSdp: правка fmtp Opus в SDP, который мы отправляем (FEC, DTX, minptime, maxaveragebitrate, mono);
//  - orderVideoCodecs: порядок видеокодеков для setCodecPreferences (iOS -> H.264, и т.п.), список сохраняется целиком;
//  - extractSample: из getStats() считает потери/RTT/джиттер/битрейт/кадры за интервал;
//  - createController: цикл адаптации (лестница качества + аудио-режим + гистерезис);
//  - groupVideoPlan / groupLimit: бюджет исходящего канала в mesh-звонке;
//  - rtcConfigFor: конфигурация RTCPeerConnection с режимом «скрывать IP» (только relay);
//  - sortIceByRtt: TURN-серверы по измеренному RTT;
//  - createReport / summarizeReport: опциональный отчёт о качестве звонка.
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.EtherCallQuality = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------- Opus / SDP ----------
  // Битрейт Opus по классу сети (бит/с): хорошая сеть оставляет прозрачную речь, плохая экономит канал под FEC.
  const OPUS_BITRATE = { good: 64000, fair: 40000, poor: 24000 };

  function parseFmtp(s) {
    const out = new Map();
    for (const part of String(s || "").split(";")) {
      const t = part.trim(); if (!t) continue;
      const i = t.indexOf("=");
      if (i < 0) out.set(t, null); else out.set(t.slice(0, i).trim(), t.slice(i + 1).trim());
    }
    return out;
  }
  function fmtFmtp(m) {
    return Array.from(m).map(([k, v]) => (v === null ? k : k + "=" + v)).join(";");
  }

  // opts: { netClass:"good|fair|poor", maxAverageBitrate, dtx:true, fec:true, minptime:10, ptime }
  // Меняет ТОЛЬКО fmtp Opus в аудио-секциях; нет Opus / нет секции / мусор -> строка возвращается как есть. Идемпотентна.
  function tuneOpusSdp(sdp, opts) {
    if (typeof sdp !== "string" || sdp.indexOf("opus/48000") < 0) return sdp;
    const o = opts || {};
    const eol = sdp.indexOf("\r\n") >= 0 ? "\r\n" : "\n";
    const lines = sdp.split(/\r?\n/);
    const br = o.maxAverageBitrate != null ? o.maxAverageBitrate : OPUS_BITRATE[o.netClass || "good"] || OPUS_BITRATE.good;
    const want = new Map();
    if (o.fec !== false) want.set("useinbandfec", "1");
    if (o.dtx !== false) want.set("usedtx", "1");
    want.set("minptime", String(o.minptime || 10));
    if (br > 0) want.set("maxaveragebitrate", String(Math.round(br)));
    want.set("stereo", "0");
    want.set("sprop-stereo", "0");
    if (o.dtx === false) want.set("usedtx", "0");
    let inAudio = false;
    const opusPts = [];
    for (const l of lines) {
      if (l.startsWith("m=")) inAudio = l.startsWith("m=audio");
      const m = inAudio && /^a=rtpmap:(\d+) opus\/48000(?:\/2)?\s*$/i.exec(l);
      if (m) opusPts.push(m[1]);
    }
    if (!opusPts.length) return sdp;
    const out = [];
    inAudio = false;
    const done = new Set();
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith("m=")) inAudio = l.startsWith("m=audio");
      const f = inAudio && /^a=fmtp:(\d+) (.*)$/.exec(l);
      if (f && opusPts.includes(f[1])) {
        const cur = parseFmtp(f[2]);
        for (const [k, v] of want) cur.set(k, v);
        out.push("a=fmtp:" + f[1] + " " + fmtFmtp(cur));
        done.add(f[1]);
        continue;
      }
      out.push(l);
      const r = inAudio && /^a=rtpmap:(\d+) opus\/48000/i.exec(l);
      if (r && opusPts.includes(r[1]) && !lines.some((x) => x.startsWith("a=fmtp:" + r[1] + " "))) {
        out.push("a=fmtp:" + r[1] + " " + fmtFmtp(new Map(want)));
        done.add(r[1]);
      }
    }
    if (o.ptime) {
      // a=ptime уже может быть — не дублируем
      const hasPtime = out.some((x) => x.startsWith("a=ptime:"));
      if (!hasPtime) { const at = out.findIndex((x) => /^a=fmtp:\d+ .*minptime/.test(x)); if (at >= 0) out.splice(at + 1, 0, "a=ptime:" + o.ptime); }
    }
    return out.join(eol);
  }

  // ---------- видеокодеки ----------
  // caps: [{mimeType:"video/VP9", ...}]; env: {ios, android, cores, allowAV1}. Возвращает НОВЫЙ массив той же длины
  // (RTX/RED/ULPFEC и неизвестные остаются в хвосте -> откат на любой кодек собеседника сохраняется).
  function orderVideoCodecs(caps, env) {
    if (!Array.isArray(caps) || !caps.length) return caps || [];
    const e = env || {};
    let pref;
    if (e.ios) pref = ["video/h264", "video/vp8"];
    else if (e.android) pref = ["video/h264", "video/vp8", "video/vp9"];
    else if ((e.cores || 0) >= 8) pref = e.allowAV1 ? ["video/av1", "video/vp9", "video/vp8", "video/h264"] : ["video/vp9", "video/vp8", "video/h264"];
    else if ((e.cores || 0) >= 4) pref = ["video/vp9", "video/vp8", "video/h264"];
    else pref = ["video/vp8", "video/h264"];
    const rank = (c) => { const i = pref.indexOf(String(c.mimeType || "").toLowerCase()); return i < 0 ? 100 : i; };
    return caps.map((c, i) => ({ c, i })).sort((a, b) => (rank(a.c) - rank(b.c)) || (a.i - b.i)).map((x) => x.c);
  }

  // ---------- статистика ----------
  // prev — предыдущий "сырой" срез (то, что вернул прошлый extractSample в .raw) либо null.
  function extractSample(stats, prev) {
    const byId = new Map();
    stats.forEach((r) => byId.set(r.id, r));
    const raw = { t: 0, inRecv: 0, inLost: 0, outSent: 0, outBytes: 0, vOutBytes: 0, vFrames: 0, freezes: 0, vDecoded: 0 };
    let rtt = null, jitter = null, avail = null, fps = null, codecId = null, pair = null, vCodecId = null;
    stats.forEach((r) => {
      const kind = r.kind || r.mediaType;
      if (r.timestamp && r.timestamp > raw.t) raw.t = r.timestamp;
      if (r.type === "candidate-pair" && (r.selected || r.nominated) && r.state === "succeeded") { if (!pair || r.selected) pair = r; }
      if (r.type === "transport" && r.selectedCandidatePairId && byId.get(r.selectedCandidatePairId)) pair = byId.get(r.selectedCandidatePairId);
      if (r.type === "inbound-rtp") {
        raw.inRecv += r.packetsReceived || 0; raw.inLost += Math.max(0, r.packetsLost || 0);
        if (typeof r.jitter === "number") jitter = Math.max(jitter || 0, r.jitter * 1000);
        if (kind === "video") { raw.freezes += r.freezeCount || 0; raw.vDecoded += r.framesDecoded || 0; if (typeof r.framesPerSecond === "number") fps = r.framesPerSecond; vCodecId = r.codecId || vCodecId; }
        if (kind === "audio") codecId = r.codecId || codecId;
      }
      if (r.type === "remote-inbound-rtp") {
        // потери и RTT с точки зрения собеседника — именно по ним видно, как доходит НАШ исходящий поток
        raw.outSent += 1; // маркер наличия
        if (typeof r.roundTripTime === "number" && rtt == null) rtt = r.roundTripTime * 1000;
        raw.remoteLostFrac = Math.max(raw.remoteLostFrac || 0, r.fractionLost || 0);
        if (typeof r.jitter === "number") jitter = Math.max(jitter || 0, r.jitter * 1000);
      }
      if (r.type === "outbound-rtp") { raw.outBytes += r.bytesSent || 0; if (kind === "video") { raw.vOutBytes += r.bytesSent || 0; raw.vFrames += r.framesSent || 0; } }
    });
    if (pair) {
      if (typeof pair.currentRoundTripTime === "number") rtt = pair.currentRoundTripTime * 1000;
      if (typeof pair.availableOutgoingBitrate === "number") avail = pair.availableOutgoingBitrate;
    }
    let lossPct = 0, outKbps = null, sentFps = null, freezeDelta = 0;
    if (prev && raw.t > prev.t) {
      const dRecv = raw.inRecv - prev.inRecv, dLost = raw.inLost - prev.inLost;
      if (dRecv + dLost > 0 && dLost >= 0) lossPct = dLost / (dRecv + dLost) * 100;
      const dt = (raw.t - prev.t) / 1000;
      if (raw.outBytes >= prev.outBytes) outKbps = (raw.outBytes - prev.outBytes) * 8 / dt / 1000;
      if (raw.vFrames >= prev.vFrames) sentFps = (raw.vFrames - prev.vFrames) / dt;
      freezeDelta = Math.max(0, raw.freezes - prev.freezes);
    }
    // потери нашего исходящего потока по данным собеседника (fractionLost 0..1) — берём худшее из двух
    if (raw.remoteLostFrac) lossPct = Math.max(lossPct, raw.remoteLostFrac * 100);
    const codecOf = (id) => { const c = id && byId.get(id); return c && c.mimeType ? String(c.mimeType).replace(/^(audio|video)\//i, "") : null; };
    const lp = pair && byId.get(pair.localCandidateId), rp = pair && byId.get(pair.remoteCandidateId);
    return {
      raw, lossPct, rttMs: rtt, jitterMs: jitter, availBps: avail, fps: sentFps != null ? sentFps : fps, outKbps, freezeDelta,
      audioCodec: codecOf(codecId), videoCodec: codecOf(vCodecId),
      pathType: pair ? ((lp && lp.candidateType === "relay") || (rp && rp.candidateType === "relay") ? "relay" : "direct") : null,
      pairType: pair ? ((lp && lp.candidateType) || "?") + "/" + ((rp && rp.candidateType) || "?") : null,
    };
  }

  // ---------- цикл адаптации ----------
  // Лестница видео (доли от базового битрейта): 0 полное, 1 мягкое, 2 среднее, 3 экономное, 4 только аудио.
  const LADDER = [
    { bitrate: 1.0, fps: 30, scale: 1 },
    { bitrate: 0.6, fps: 30, scale: 1 },
    { bitrate: 0.35, fps: 24, scale: 2 },
    { bitrate: 0.18, fps: 15, scale: 2 },
    { bitrate: 0, fps: 0, scale: 4 },
  ];
  const TICK_MS = 2000;
  const DEFAULTS = {
    baseVideoBps: 2500000, minVideoBps: 120000,
    degradeLoss: 5, degradeRtt: 400,        // «плохо»: шаг вниз по лестнице после degradeTicks подряд
    severeLoss: 15, severeRtt: 800,         // «очень плохо»: в аудио-режим после severeTicks подряд (6 с)
    goodLoss: 2, goodRtt: 250,              // «хорошо» для подъёма
    degradeTicks: 2, severeTicks: 3,
    upTicks: 8,                              // 16 с стабильно хорошо — шаг вверх
    restoreFromAudioTicks: 15,               // 30 с — выход из аудио-режима (гистерезис шире, чтобы не мигало)
  };

  function classify(sample, cfg) {
    const loss = sample.lossPct || 0, rtt = sample.rttMs == null ? 0 : sample.rttMs;
    if (loss >= cfg.severeLoss || rtt >= cfg.severeRtt) return "severe";
    if (loss >= cfg.degradeLoss || rtt >= cfg.degradeRtt || (sample.freezeDelta || 0) > 1) return "bad";
    if (loss <= cfg.goodLoss && rtt <= cfg.goodRtt) return "good";
    return "ok";
  }
  function netClassOf(loss, rtt) {
    if (loss >= 8 || rtt >= 400) return "poor";
    if (loss >= 3 || rtt >= 200) return "fair";
    return "good";
  }

  // step(sample) -> { level, audioOnly, video:{maxBitrate,maxFramerate,scaleResolutionDownBy}|null, netClass, opusBitrate, changed, reason }
  function createController(options) {
    const cfg = Object.assign({}, DEFAULTS, options || {});
    let level = 0, bad = 0, severe = 0, good = 0, reason = "", cls = "good", clsCand = "good", clsN = 0, base = cfg.baseVideoBps, hasVideo = cfg.hasVideo !== false;
    function plan() {
      const L = LADDER[level];
      const audioOnly = level === LADDER.length - 1;
      return {
        level, audioOnly, netClass: cls, opusBitrate: OPUS_BITRATE[cls], reason,
        video: audioOnly ? null : { maxBitrate: Math.max(cfg.minVideoBps, Math.round(base * L.bitrate)), maxFramerate: L.fps, scaleResolutionDownBy: L.scale },
      };
    }
    return {
      get level() { return level; },
      setBase(bps) { base = Math.max(cfg.minVideoBps, bps); },
      setHasVideo(v) { hasVideo = !!v; },
      plan,
      step(sample) {
        const prevLevel = level, prevCls = cls;
        const c = classify(sample, cfg);
        // класс сети для Opus: смена только после 3 одинаковых оценок подряд (без дребезга)
        const nc = netClassOf(sample.lossPct || 0, sample.rttMs == null ? 0 : sample.rttMs);
        if (nc === clsCand) clsN++; else { clsCand = nc; clsN = 1; }
        if (clsCand !== cls && clsN >= (OPUS_BITRATE[clsCand] < OPUS_BITRATE[cls] ? 2 : 6)) cls = clsCand;
        if (hasVideo) {
          if (c === "severe") { severe++; bad++; good = 0; } else if (c === "bad") { severe = 0; bad++; good = 0; } else if (c === "good") { bad = 0; severe = 0; good++; } else { bad = 0; severe = 0; good = 0; }
          const last = LADDER.length - 1;
          if (level < last && severe >= cfg.severeTicks) { level = last; reason = "severe"; bad = severe = good = 0; }
          else if (level < last && bad >= cfg.degradeTicks) { level++; reason = c === "severe" ? "severe" : "degraded"; bad = good = 0; }
          else if (level < last && sample.availBps > 0) {
            // оценка исходящего канала ниже текущей цели — подгоняем сразу, без ожидания потерь
            const target = Math.max(cfg.minVideoBps, Math.round(base * LADDER[level].bitrate));
            if (sample.availBps < target * 0.8 && level < last - 1) { level++; reason = "bandwidth"; bad = severe = good = 0; }
          }
          if (level > 0) {
            const need = level === LADDER.length - 1 ? cfg.restoreFromAudioTicks : cfg.upTicks;
            if (good >= need) { level--; reason = "restored"; good = 0; }
          }
        } else if (c === "good") good++;
        return Object.assign(plan(), { changed: level !== prevLevel || cls !== prevCls, prevLevel });
      },
    };
  }

  // ---------- группа (mesh) ----------
  // Видео уходит каждому участнику отдельно: бюджет делим на число видео-получателей. >4 получателей -> только аудио.
  function groupVideoPlan(opts) {
    const o = Object.assign({ peers: 1, uplinkBps: 2000000, maxVideoPeers: 4, minVideoBps: 150000, maxVideoBps: 1200000, audioShareBps: 64000 }, opts || {});
    const peers = Math.max(0, o.peers | 0);
    if (!peers) return { video: false, perPeerBps: 0 };
    if (peers > o.maxVideoPeers) return { video: false, perPeerBps: 0, reason: "many-peers" };
    const budget = Math.max(0, o.uplinkBps * 0.85 - peers * o.audioShareBps);
    const per = Math.min(o.maxVideoBps, Math.floor(budget / peers));
    if (per < o.minVideoBps) return { video: false, perPeerBps: 0, reason: "uplink" };
    return { video: true, perPeerBps: per };
  }
  // Предел участников mesh: 6 по умолчанию; слабый исходящий канал / слабое устройство -> меньше.
  function groupLimit(opts) {
    const o = opts || {};
    let n = o.max || 6;
    if (o.uplinkBps > 0) {
      // аудио-only mesh: (n-1) потоков по ~64 кбит/с + запас
      const fit = Math.floor(o.uplinkBps * 0.8 / 80000) + 1;
      n = Math.min(n, Math.max(3, fit));
    }
    if (o.cores > 0 && o.cores <= 2) n = Math.min(n, 4);
    return Math.max(2, n);
  }

  // ---------- конфигурация RTCPeerConnection ----------
  // hideIp: только relay (IP не уходит собеседнику, ценой задержки). Нет TURN -> всё равно relay (лучше не соединиться, чем раскрыть IP).
  function rtcConfigFor(o) {
    const servers = (o && o.iceServers) || [];
    if (o && o.hideIp) {
      const turn = [];
      for (const s of servers) {
        const urls = [].concat(s.urls || []).filter((u) => /^turns?:/i.test(u));
        // UDP-relay раньше TCP: меньше задержка; TCP/TLS остаются как запасной путь
        urls.sort((a, b) => (/transport=tcp|^turns:/i.test(a) ? 1 : 0) - (/transport=tcp|^turns:/i.test(b) ? 1 : 0));
        if (urls.length) turn.push(Object.assign({}, s, { urls }));
      }
      return { iceServers: turn, iceTransportPolicy: "relay" };
    }
    if (o && o.relayOnly) return { iceServers: o.relayServers || [], iceTransportPolicy: "relay" };
    return { iceServers: servers, iceCandidatePoolSize: o && o.poolSize ? o.poolSize : 0 };
  }

  // TURN по измеренному RTT: rttMap url->мс (null/undefined = не измерялось -> после измеренных, провалы в самом конце). STUN-серверы вперёд не лезут.
  function sortIceByRtt(servers, rttMap) {
    const score = (s) => {
      const urls = [].concat(s.urls || []);
      if (!urls.some((u) => /^turns?:/i.test(u))) return -1;
      let best = Infinity, failed = false;
      for (const u of urls) { const v = rttMap && rttMap[u]; if (v === -1) failed = true; else if (typeof v === "number" && v < best) best = v; }
      if (best !== Infinity) return best;
      return failed ? 1e9 : 1e6;
    };
    return servers.map((s, i) => ({ s, i, k: score(s) })).sort((a, b) => (a.k - b.k) || (a.i - b.i)).map((x) => x.s);
  }

  // ---------- отчёт ----------
  function createReport(max) {
    return { startedAt: Date.now(), samples: [], reconnects: 0, meta: {}, max: max || 600 };
  }
  function reportAdd(rep, s) {
    rep.samples.push({ t: Date.now() - rep.startedAt, rtt: s.rttMs, jitter: s.jitterMs, loss: s.lossPct, kbps: s.outKbps, fps: s.fps, level: s.level });
    if (rep.samples.length > rep.max) rep.samples.shift();
    if (s.audioCodec) rep.meta.audioCodec = s.audioCodec;
    if (s.videoCodec) rep.meta.videoCodec = s.videoCodec;
    if (s.pathType) rep.meta.pathType = s.pathType;
    if (s.pairType) rep.meta.pairType = s.pairType;
  }
  function pct(arr, p) { if (!arr.length) return null; const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; }
  // Вердикт по звуку: excellent / good / fair / poor / unknown (+ отдельно причины)
  function summarizeReport(rep) {
    const vals = (k) => rep.samples.map((x) => x[k]).filter((v) => typeof v === "number" && isFinite(v));
    const rtt = vals("rtt"), jit = vals("jitter"), loss = vals("loss"), kb = vals("kbps"), lv = vals("level");
    if (rep.samples.length < 3) return { verdict: "unknown", samples: rep.samples.length };
    const rttMed = pct(rtt, 0.5), jitP95 = pct(jit, 0.95), lossAvg = loss.length ? loss.reduce((a, b) => a + b, 0) / loss.length : 0, lossP95 = pct(loss, 0.95);
    let verdict = "excellent";
    if ((rttMed || 0) > 150 || (jitP95 || 0) > 30 || lossAvg > 1 || (lossP95 || 0) > 3) verdict = "good";
    if ((rttMed || 0) > 300 || (jitP95 || 0) > 60 || lossAvg > 3 || (lossP95 || 0) > 8) verdict = "fair";
    if ((rttMed || 0) > 500 || (jitP95 || 0) > 100 || lossAvg > 8 || (lossP95 || 0) > 15) verdict = "poor";
    if (rep.reconnects >= 3 && verdict === "excellent") verdict = "good";
    const maxLevel = lv.length ? Math.max.apply(null, lv) : 0;
    return {
      verdict, samples: rep.samples.length, durationS: Math.round((rep.samples[rep.samples.length - 1].t || 0) / 1000),
      rttMedianMs: rttMed == null ? null : Math.round(rttMed), jitterP95Ms: jitP95 == null ? null : Math.round(jitP95),
      lossAvgPct: Math.round(lossAvg * 10) / 10, lossP95Pct: lossP95 == null ? null : Math.round(lossP95 * 10) / 10,
      avgKbps: kb.length ? Math.round(kb.reduce((a, b) => a + b, 0) / kb.length) : null,
      videoDegraded: maxLevel > 0, audioOnlyUsed: maxLevel >= LADDER.length - 1, reconnects: rep.reconnects,
      path: rep.meta.pathType || null, pair: rep.meta.pairType || null, audioCodec: rep.meta.audioCodec || null, videoCodec: rep.meta.videoCodec || null,
    };
  }
  function reportToJson(rep) {
    return JSON.stringify({ version: 1, startedAt: new Date(rep.startedAt).toISOString(), summary: summarizeReport(rep), meta: rep.meta, reconnects: rep.reconnects, samples: rep.samples }, null, 2);
  }

  return { OPUS_BITRATE, LADDER, TICK_MS, DEFAULTS, tuneOpusSdp, orderVideoCodecs, extractSample, createController, groupVideoPlan, groupLimit, rtcConfigFor, sortIceByRtt, createReport, reportAdd, summarizeReport, reportToJson };
});
