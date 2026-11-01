// V.87: хранилище зашифрованных вложений (blobs.js) и SFU (sfu.js): билеты, квоты, загрузка/скачивание; SFU пересылает
// RTP-пакеты участникам группы без изменения полезной нагрузки (зашифрованные кадры остаются непрозрачными), чужих не пускает.
const WebSocket = require("ws"), http = require("http"), os = require("os"), path = require("path"), fs = require("fs");
const W = require("werift");
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "blobs-"));
Object.assign(process.env, { PORT: "8833", MAILBOX_PERSIST: "0", VAPID_PUBLIC: "", VAPID_PRIVATE: "", GROUPS_PERSIST: "0", CHANNELS_PERSIST: "0", BLOBS_DIR: DIR, BLOB_MAX_BYTES: "4096", BLOB_DAILY_BYTES: "6000", SFU: "1" });
require("./server.js");
let pass = 0, fail = 0;
function check(label, cond) { if (cond) { pass++; console.log("  OK   " + label); } else { fail++; console.log("  FAIL " + label); } }
const w = (ms) => new Promise((r) => setTimeout(r, ms));
const open = (id) => new Promise((resolve) => { const ws = new WebSocket("ws://localhost:8833"); const ev = []; ws.on("message", (r) => ev.push(JSON.parse(r))); ws.on("open", () => { ws.send(JSON.stringify({ type: "register", id, name: id })); setTimeout(() => resolve({ ws, ev, send: (m) => ws.send(JSON.stringify(m)) }), 200); }); });
const req = (method, p, body) => new Promise((res) => { const r = http.request({ host: "localhost", port: 8833, path: p, method }, (resp) => { const ch = []; resp.on("data", (c) => ch.push(c)); resp.on("end", () => res({ status: resp.statusCode, body: Buffer.concat(ch) })); }); r.on("error", () => res({ status: 0 })); if (body) r.write(body); r.end(); });
const waitFor = async (fn, ms) => { for (let i = 0; i < ms / 50; i++) { const v = fn(); if (v) return v; await w(50); } return null; };

async function sfuClient(C, gid) {
  const codecs = { audio: [new W.RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2, payloadType: 111 })], video: [new W.RTCRtpCodecParameters({ mimeType: "video/VP8", clockRate: 90000, payloadType: 96 })] };
  const pc = new W.RTCPeerConnection({ codecs, iceAdditionalHostAddresses: ["127.0.0.1"] });
  const out = { pc, got: [], track: new W.MediaStreamTrack({ kind: "audio" }), offers: 0 };
  pc.onTrack.subscribe((t) => t.onReceiveRtp.subscribe((rtp) => out.got.push(rtp)));
  C.ws.on("message", async (raw) => {
    const m = JSON.parse(raw); if (m.type !== "sfu-offer" || m.gid !== gid) return;
    out.offers++;
    await pc.setRemoteDescription({ type: "offer", sdp: m.sdp });
    for (const t of pc.getTransceivers()) {
      if (t.mid === m.up.audio) { t.setDirection("sendonly"); if (!t.sender.track) await t.sender.replaceTrack(out.track); }
      else if (t.mid === m.up.video) t.setDirection("inactive");
      else t.setDirection("recvonly");
    }
    const ans = await pc.createAnswer(); await pc.setLocalDescription(ans);
    await new Promise((r) => { if (pc.iceGatheringState === "complete") return r(); const tt = setTimeout(r, 2000); pc.iceGatheringStateChange.subscribe((s) => { if (s === "complete") { clearTimeout(tt); r(); } }); });
    C.send({ type: "sfu-answer", gid, sdp: pc.localDescription.sdp });
  });
  C.send({ type: "sfu-join", gid });
  return out;
}

(async () => {
  await w(400);
  const A = await open("bl-a"), B = await open("bl-b"), X = await open("bl-x");
  // ---------- хранилище ----------
  A.send({ type: "blob-ticket", rid: "r1", size: 5000 }); await w(100);
  check("больше BLOB_MAX_BYTES — отказ", A.ev.some((e) => e.type === "blob-ticket" && e.rid === "r1" && e.error === "size"));
  A.send({ type: "blob-ticket", rid: "r2", size: 3000 }); await w(100);
  const t = A.ev.find((e) => e.type === "blob-ticket" && e.rid === "r2");
  check("билет выдан: id 32 hex, токен", t && /^[0-9a-f]{32}$/.test(t.id) && t.token && !t.error);
  const body = Buffer.alloc(3000, 7);
  check("без токена загрузка запрещена", (await req("PUT", "/blob/" + t.id, body)).status === 403);
  // (403 без токена тратит только попытку, билет остаётся)
  const up = await req("PUT", "/blob/" + t.id + "?t=" + t.token, body);
  check("загрузка по билету: 201", up.status === 201);
  check("повтор билета не работает", (await req("PUT", "/blob/" + t.id + "?t=" + t.token, body)).status === 403);
  const got = await req("GET", "/blob/" + t.id);
  check("скачивание по id отдаёт те же байты", got.status === 200 && got.body.equals(body));
  check("несуществующий id — 404", (await req("GET", "/blob/" + "0".repeat(32))).status === 404);
  A.send({ type: "blob-ticket", rid: "r3", size: 3500 }); await w(100);
  check("суточная квота отправителя", A.ev.some((e) => e.rid === "r3" && e.error === "quota"));
  A.send({ type: "blob-ticket", rid: "r4", size: 100 }); await w(100);
  const t4 = A.ev.find((e) => e.rid === "r4");
  check("неполная загрузка отвергается", (await req("PUT", "/blob/" + t4.id + "?t=" + t4.token, Buffer.alloc(50))).status === 400);
  const reg = A.ev.find((e) => e.type === "registered");
  check("сервер объявляет blob и sfu", reg && reg.features.includes("blob") && reg.features.includes("sfu"));

  // ---------- SFU ----------
  const GID = "grp-sfu-0001";
  A.send({ type: "group-roster", gid: GID, members: ["bl-a", "bl-b"], ver: 1 }); await w(150);
  X.send({ type: "sfu-join", gid: GID }); await w(150);
  check("не участник группы не входит", X.ev.some((e) => e.type === "sfu-joined" && e.error === "not-member"));
  const ca = await sfuClient(A, GID);
  await waitFor(() => A.ev.some((e) => e.type === "sfu-joined" && e.ok), 3000);
  const cb = await sfuClient(B, GID);
  const joinedB = await waitFor(() => B.ev.find((e) => e.type === "sfu-joined"), 3000);
  check("участник входит, видит уже вошедших", joinedB && joinedB.ok && joinedB.peers.includes("bl-a"));
  const conn = await waitFor(() => ca.pc.iceConnectionState === "connected" && cb.pc.iceConnectionState === "connected" && ca.offers >= 2, 15000);
  check("оба соединены с сервером, A пересогласован при входе B", !!conn);
  await w(1500);
  // A шлёт «зашифрованные» RTP-пакеты; B должен получить ровно ту же полезную нагрузку
  const payload = Buffer.from("e2ee-frame-opaque-0123456789");
  for (let i = 0; i < 40; i++) {
    const rtp = new W.RtpPacket(new W.RtpHeader({ payloadType: 111, sequenceNumber: 1000 + i, timestamp: 960 * i, ssrc: 1234, marker: true }), payload);
    ca.track.writeRtp(rtp); await w(20);
  }
  const fw = await waitFor(() => cb.got.find((r) => Buffer.compare(r.payload, payload) === 0), 5000);
  check("SFU переслал RTP с неизменной (зашифрованной) нагрузкой", !!fw);
  check("отправитель не получает свой поток обратно", !ca.got.some((r) => Buffer.compare(r.payload, payload) === 0));
  A.send({ type: "sfu-leave", gid: GID });
  check("уход участника: остальным приходит sfu-left", !!(await waitFor(() => B.ev.some((e) => e.type === "sfu-left" && e.id === "bl-a"), 3000)));
  try { ca.pc.close(); cb.pc.close(); } catch (e) {}
  console.log(`\nИтого: ${pass} прошло, ${fail} упало`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
