// V.86: воркер шифрования кадров (RTCRtpScriptTransform). Ключи приходят сообщениями из окна:
// { type: "key", owner: "me" | <id участника>, epoch, raw } и { type: "drop", owner }.
importScripts("framecrypt.js");
const keys = new Map(); // owner -> Map(epoch -> CryptoKey)
let my = null, ctr = 1;
self.onmessage = async (ev) => {
  const d = ev.data || {};
  if (d.type === "key" && d.raw) {
    const k = await FrameCrypt.importKey(new Uint8Array(d.raw));
    if (d.owner === "me") { my = { epoch: d.epoch & 255, key: k }; ctr = 1; }
    else { if (!keys.has(d.owner)) keys.set(d.owner, new Map()); const m = keys.get(d.owner); m.set(d.epoch & 255, k); if (m.size > 3) m.delete(m.keys().next().value); }
  } else if (d.type === "drop") keys.delete(d.owner);
};
self.onrtctransform = (ev) => {
  const t = ev.transformer, o = t.options || {};
  const kindOf = (f) => (f.type === undefined ? "audio" : "video");
  const stream = new TransformStream({
    async transform(frame, ctl) {
      const clear = FrameCrypt.clearBytesFor(kindOf(frame), frame.type === "key");
      if (o.dir === "enc") {
        if (!my) return; // ключа ещё нет — кадр не уходит открытым
        frame.data = await FrameCrypt.encrypt(my.key, my.epoch, ctr++, frame.data, clear);
        ctl.enqueue(frame);
      } else {
        const m = keys.get(o.peer); const pt = m ? await FrameCrypt.decrypt((e) => m.get(e) || null, frame.data, clear) : null;
        if (!pt) return; // не расшифровался — выбрасываем, а не показываем мусор
        frame.data = pt; ctl.enqueue(frame);
      }
    },
  });
  t.readable.pipeThrough(stream).pipeTo(t.writable).catch(() => {});
};
