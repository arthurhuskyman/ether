// Каналы (рассылка один-ко-многим), клиентская криптография и разбор ссылок. Сеть и интерфейс — в js/app/15-channels.js, сервер — signaling-server/channels.js.
// Модель доверия: владелец создаёт канал с парой ECDSA P-256 (закрытый ключ только у него). Подписчик закрепляет ХЕШ открытого ключа из ссылки
// #ch=<id>.<хеш>[.<ключ>]; сервер отдаёт открытый ключ при подписке, и он принимается только если хеш совпал. Каждый пост подписан владельцем, подпись
// проверяют и сервер (отсекает чужие), и клиент (сервер не может сочинить пост). Мета (название, описание, аватар-хеш, версия ключа) тоже подписана.
// Шифрование (необязательно, «закрытый канал»): симметричный ключ канала AES-256-GCM лежит во фрагменте ссылки-приглашения (фрагмент не уходит на сервер),
// поэтому «доставка ключа подписчику» = сама ссылка/QR; сервер хранит только шифртекст. Смена ключа (kv+1) = новая ссылка: старые подписчики новых постов не прочтут.
const Channels = (() => {
  const te = new TextEncoder(), td = new TextDecoder();
  const ALG = { name: "ECDSA", namedCurve: "P-256" }, SIG = { name: "ECDSA", hash: "SHA-256" };
  const MAX_BODY = 200000, MAX_MEDIA = 140000;
  const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); };
  const unb64 = (str) => { const s = atob(str.replace(/-/g, "+").replace(/_/g, "/")); const o = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) o[i] = s.charCodeAt(i); return o; };
  const b64u = (u8) => b64(u8).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const hex = (u8) => Array.from(u8, (x) => x.toString(16).padStart(2, "0")).join("");
  const clean = (s, n) => String(s == null ? "" : s).replace(/[|\n\r]/g, " ").slice(0, n);
  const ID_RE = /^[a-z0-9]{12,32}$/;
  const IMG_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

  // Канонические строки подписи: ОБЯЗАНЫ совпадать с signaling-server/channels.js
  const metaMsg = (id, m) => te.encode(["ether-chmeta-v1", id, clean(m.name, 60), clean(m.desc, 200), m.enc ? 1 : 0, Number(m.ts), (m.kv | 0), m.av || ""].join("|"));
  const postMsg = (id, p) => te.encode(["ether-chpost-v1", id, p.id, p.ts, p.enc ? 1 : 0, (p.kv | 0), p.iv || "", p.body].join("|"));
  const delMsg = (id, ts) => te.encode(["ether-chdel-v1", id, ts].join("|"));

  const sha = async (s) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(s))));
  const pubHash = async (pub) => (await sha("ether-chpub|" + pub.x + "|" + pub.y)).slice(0, 26);
  const signKey = (j) => crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: j.x, y: j.y, d: j.d, ext: true }, ALG, false, ["sign"]);
  const verKey = (j) => crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: j.x, y: j.y, ext: true }, ALG, false, ["verify"]);
  const sign = async (priv, msg) => b64(new Uint8Array(await crypto.subtle.sign(SIG, await signKey(priv), msg)));
  const verify = async (pub, msg, sig) => { try { return await crypto.subtle.verify(SIG, await verKey(pub), unb64(sig), msg); } catch (e) { return false; } };
  const rid = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));

  // ---------- создание и мета ----------
  async function signMeta(c, meta) {
    const m = { name: clean(meta.name, 60), desc: clean(meta.desc || "", 200), enc: !!meta.enc, ts: meta.ts || Date.now(), kv: meta.kv | 0 };
    if (meta.avatar && IMG_RE.test(meta.avatar) && meta.avatar.length <= 30000) { m.avatar = meta.avatar; m.av = await sha(meta.avatar); }
    return { meta: m, metaSig: await sign(c.priv, metaMsg(c.id, m)) };
  }
  async function generate(opts) {
    const kp = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
    const j = await crypto.subtle.exportKey("jwk", kp.privateKey);
    const c = { id: rid(8), pub: { x: j.x, y: j.y }, priv: { x: j.x, y: j.y, d: j.d }, kv: 0, key: opts.enc ? b64(crypto.getRandomValues(new Uint8Array(32))) : null };
    c.pubHash = await pubHash(c.pub);
    Object.assign(c, await signMeta(c, { name: opts.name, desc: opts.desc, enc: !!opts.enc, kv: 0, avatar: opts.avatar }));
    return c;
  }
  async function verifyMeta(id, pub, meta, sig) {
    if (!meta || typeof meta.name !== "string" || !Number.isSafeInteger(meta.ts)) return false;
    if (meta.avatar != null && (!IMG_RE.test(meta.avatar) || (await sha(meta.avatar)) !== meta.av)) return false;
    return verify(pub, metaMsg(id, meta), sig);
  }
  const signDelete = async (c, ts) => ({ ts, sig: await sign(c.priv, delMsg(c.id, ts)) });

  // ---------- ссылки ----------
  // Фрагмент: ch=<id>.<хеш ключа>[.<ключ канала base64url>]
  function fragment(c) { return "ch=" + c.id + "." + c.pubHash + (c.key ? "." + b64u(unb64(c.key)) : ""); }
  function parseLink(text) {
    const m = /(?:^|[#&?\s])ch=([a-z0-9]{12,32})\.([0-9a-f]{26})(?:\.([A-Za-z0-9_-]{43}))?(?![A-Za-z0-9_-])/.exec(String(text || ""));
    if (!m) return null;
    return { id: m[1], hash: m[2], key: m[3] ? b64(unb64(m[3])) : null };
  }

  // ---------- посты ----------
  // content: { text, media?: {dataUrl, name?}, reply?: postId }
  function packContent(content) {
    const o = { v: 1, t: String(content.text || "").slice(0, 8000) };
    if (content.media && IMG_RE.test(content.media.dataUrl || "") && content.media.dataUrl.length <= MAX_MEDIA) o.m = { d: content.media.dataUrl, n: clean(content.media.name || "", 60) };
    if (content.reply && typeof content.reply === "string") o.r = content.reply.slice(0, 64);
    return JSON.stringify(o);
  }
  function unpackContent(s) {
    try {
      const o = JSON.parse(s); if (!o || o.v !== 1 || typeof o.t !== "string") return null;
      const out = { text: o.t.slice(0, 8000) };
      if (o.m && typeof o.m.d === "string" && IMG_RE.test(o.m.d) && o.m.d.length <= MAX_MEDIA) out.media = { dataUrl: o.m.d, name: typeof o.m.n === "string" ? o.m.n.slice(0, 60) : "" };
      if (typeof o.r === "string") out.reply = o.r.slice(0, 64);
      return out;
    } catch (e) { return null; }
  }
  const aesKey = (b) => crypto.subtle.importKey("raw", unb64(b), "AES-GCM", false, ["encrypt", "decrypt"]);
  const aad = (id, pid, kv) => te.encode(["ether-chenc-v1", id, pid, kv | 0].join("|"));
  async function makePost(c, content, now) {
    const plain = packContent(content);
    if (plain.length > MAX_BODY) throw new Error("channel: post too big");
    const p = { id: rid(12), ts: now || Date.now(), kv: c.kv | 0 };
    if (c.key) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      p.enc = true; p.iv = b64(iv);
      p.body = b64(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(c.id, p.id, p.kv) }, await aesKey(c.key), te.encode(plain))));
    } else { p.enc = false; p.body = plain; }
    p.sig = await sign(c.priv, postMsg(c.id, p));
    return p;
  }
  // Проверка подписи закреплённым ключом + расшифровка. -> { ok, content, reason: "bad-sig"|"no-key"|"auth"|"format" }
  async function openPost(c, post) {
    if (!post || typeof post.id !== "string" || typeof post.body !== "string" || !Number.isSafeInteger(post.ts)) return { ok: false, reason: "format" };
    if (!(await verify(c.pub, postMsg(c.id, post), post.sig))) return { ok: false, reason: "bad-sig" };
    let plain = post.body;
    if (post.enc) {
      if (!c.key || (post.kv | 0) !== (c.kv | 0)) return { ok: true, content: null, reason: "no-key" }; // подпись верна, прочитать нечем
      try { plain = td.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(post.iv), additionalData: aad(c.id, post.id, post.kv) }, await aesKey(c.key), unb64(post.body))); } catch (e) { return { ok: false, reason: "auth" }; }
    }
    const content = unpackContent(plain);
    return content ? { ok: true, content } : { ok: false, reason: "format" };
  }
  return { ID_RE, MAX_BODY, MAX_MEDIA, clean, metaMsg, postMsg, delMsg, pubHash, generate, signMeta, verifyMeta, signDelete, fragment, parseLink, makePost, openPost, packContent, unpackContent };
})();
if (typeof module !== "undefined") module.exports = Channels;
