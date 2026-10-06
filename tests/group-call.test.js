// Групповой звонок: три настоящих клиента (jsdom + реальный WebRTC), полный mesh из трёх PeerLink.
const test = require("node:test");
const assert = require("node:assert/strict");
const wrtc = require("@roamhq/wrtc");
const { bootApp, closeAll } = require("./harness");
test.after(closeAll);
const { RTCAudioSource, RTCVideoSource } = wrtc.nonstandard;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(50); } return false; }
const timers = [];
test.after(() => { for (const t of timers.splice(0)) clearInterval(t); setTimeout(() => process.exit(process.exitCode || 0), 1500); });

function installMedia(a) {
  const mkAudio = () => {
    const src = new RTCAudioSource(); const track = src.createTrack();
    const iv = setInterval(() => src.onData({ samples: new Int16Array(160), sampleRate: 16000, bitsPerSample: 16, channelCount: 1, numberOfFrames: 160 }), 10); timers.push(iv);
    track.addEventListener("ended", () => clearInterval(iv));
    return track;
  };
  const mkVideo = () => {
    const src = new RTCVideoSource(); const track = src.createTrack();
    const frame = () => src.onFrame({ width: 64, height: 48, data: new Uint8ClampedArray((64 * 48 * 3) / 2).fill(90) });
    frame(); const iv = setInterval(frame, 100); timers.push(iv);
    track.addEventListener("ended", () => clearInterval(iv));
    return track;
  };
  Object.defineProperty(a.window.navigator, "mediaDevices", { configurable: true, value: {
    getUserMedia: async (c) => {
      if (a.window.__denyMedia) { const e = new Error("denied"); e.name = "NotAllowedError"; throw e; }
      const tracks = [];
      if (c && c.audio) tracks.push(mkAudio());
      if (c && c.video) tracks.push(mkVideo());
      return new wrtc.MediaStream(tracks);
    },
    enumerateDevices: async () => [],
  } });
}

const IDS = ["ua", "ub", "uc"];
async function trio() {
  const apps = {};
  for (const id of IDS) {
    apps[id] = await bootApp({ storage: { "ether.myId": id, "ether.name": id.toUpperCase() } });
    installMedia(apps[id]);
  }
  for (const [x, y] of [["ua", "ub"], ["ua", "uc"], ["ub", "uc"]]) {
    const X = apps[x].run(`mesh.createOutgoingLink(${JSON.stringify(y)})`);
    const Y = apps[y].run(`mesh.createIncomingLink(${JSON.stringify(x)})`);
    const offer = await X.createInitialOffer("");
    const answer = await Y.acceptOfferAndCreateAnswer(offer);
    await X.acceptAnswer(answer);
  }
  assert.ok(await until(() => IDS.every((i) => apps[i].run(`mesh.connectedCount()`) === 2)), "полный mesh из трёх клиентов должен подняться");
  // контакты и группа — после поднятия линков, чтобы автосвязность приложения не пересоздавала их
  for (const id of IDS) {
    for (const o of IDS) if (o !== id) apps[id].run(`state.contacts.set(${JSON.stringify(o)}, { id: ${JSON.stringify(o)}, name: ${JSON.stringify(o.toUpperCase())}, managed: false, messages: [] });`);
    apps[id].run(`state.contacts.set("g1", { id: "g1", name: "Team", isGroup: true, managed: false, members: ${JSON.stringify(IDS.map((i) => ({ id: i, name: i.toUpperCase() })))}, messages: [], lastActivity: 1 });`);
  }
  return apps;
}
const peers = (a) => a.run(`GC.peers.size`);

test("групповой звонок: приглашение, вход двух участников, звук/mute, выход, системное сообщение", async () => {
  const apps = await trio();
  const { ua, ub, uc } = apps;
  await ua.run(`startGroupCall("g1", false)`);
  assert.equal(ua.run(`GC.gid`), "g1");
  assert.ok(ua.document.querySelector("#gcall-screen"), "у инициатора открыт экран группового звонка");
  assert.ok(await until(() => ub.run(`GC.invites.has("g1")`) && uc.run(`GC.invites.has("g1")`)), "оба участника получили приглашение");
  assert.ok(ub.document.querySelector("#gcall-invite"), "показан баннер приглашения");

  await ub.run(`joinGroupCall("g1")`);
  await uc.run(`joinGroupCall("g1")`);
  assert.ok(await until(() => IDS.every((i) => peers(apps[i]) === 2)), "все видят двух других участников");
  assert.ok(await until(() => IDS.every((i) => apps[i].run(`Array.from(GC.peers.values()).every((p) => !!p.stream)`))), "от каждого участника пришёл медиапоток");
  assert.equal(ua.document.querySelectorAll(".gcall-tile").length, 3);
  assert.equal(ub.document.querySelector("#gcall-invite"), null, "баннер приглашения закрылся после входа");

  ub.run(`gcallToggleMute()`);
  assert.ok(await until(() => ua.run(`GC.peers.get("ub").muted`)), "mute доходит до остальных");
  assert.ok(ua.document.querySelector('[data-peer="ub"] .gcall-muted'));

  await uc.run(`gcallToggleCamera()`);
  assert.ok(await until(() => ua.run(`GC.peers.get("uc").hasVideo`), 12000), "видео участника дошло");

  uc.run(`leaveGroupCall()`);
  assert.equal(uc.run(`GC.gid`), null);
  assert.equal(uc.document.querySelector("#gcall-screen"), null);
  assert.ok(await until(() => peers(ua) === 1 && peers(ub) === 1), "после выхода у остальных остаётся один собеседник");
  assert.ok(uc.run(`state.contacts.get("g1").messages.some((m) => m.textKey === "gcall.systemEnded")`), "в чат группы записано завершение звонка");

  ua.run(`leaveGroupCall()`); ub.run(`leaveGroupCall()`);
});

test("групповой звонок: чужие/просроченные приглашения игнорируются, лимит участников, занятость", async () => {
  const a = await bootApp({ storage: { "ether.myId": "ua" } });
  installMedia(a);
  a.run(`state.contacts.set("g1", { id: "g1", name: "Team", isGroup: true, members: [{id:"ua",name:"A"},{id:"ub",name:"B"}], messages: [] }); state.contacts.set("ux", { id: "ux", name: "X", messages: [] });`);
  a.run(`handleGroupCallPayload("ux", { kind:"gcall", t:"invite", gid:"g1", ts: Date.now() })`);
  assert.equal(a.run(`GC.invites.size`), 0, "приглашение от не-участника группы игнорируется");
  a.run(`handleGroupCallPayload("ub", { kind:"gcall", t:"invite", gid:"nope", ts: Date.now() })`);
  assert.equal(a.run(`GC.invites.size`), 0, "неизвестная группа игнорируется");
  a.run(`handleGroupCallPayload("ub", { kind:"gcall", t:"invite", gid:"g1", ts: Date.now() - 120000 })`);
  assert.equal(a.run(`GC.invites.size`), 0, "просроченное приглашение (из буфера) игнорируется");
  a.run(`handleGroupCallPayload("ub", { kind:"gcall", t:"invite", gid:"g1", ts: Date.now() })`);
  assert.equal(a.run(`GC.invites.size`), 1);
  a.run(`state.callId = "ub"`);
  a.run(`GC.invites.clear(); handleGroupCallPayload("ub", { kind:"gcall", t:"invite", gid:"g1", ts: Date.now() })`);
  assert.equal(a.run(`GC.invites.size`), 0, "во время 1:1 звонка групповые приглашения не показываются");
  a.run(`state.callId = null`);
  await a.run(`startGroupCall("g1", false)`);
  assert.equal(a.run(`GC.gid`), null, "без участников онлайн звонок не стартует");
  assert.match(a.document.querySelector("#toast").textContent, /online|в сети/i);
  assert.equal(a.run(`GCALL_MAX`), 6);
});
