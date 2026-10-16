// Разбор og:/meta-тегов для превью ссылок — за один линейный проход.
// Раньше регулярки вида <meta[^>]+…[^>]+content=… по 512 КБ чужого HTML
// давали катастрофический откат (ReDoS): страница из тысяч «<meta » вешала процесс.
// Здесь: ищем «<meta» по индексам (без вложенных квантификаторов), ограничиваем число тегов и длину
// каждого, атрибуты разбираем простыми ограниченными регулярками внутри одного тега.
const MAX_META_TAGS = 200;
const MAX_TAG_LEN = 2048;
const MAX_TITLE_LEN = 1000;

function decodeHtmlEntities(s) {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    // Числовые HTML-сущности: &#8212; (десятичные) и &#x2014; (шестнадцатеричные).
    .replace(/&#(\d+);/g, (_, code) => {
      try { return String.fromCodePoint(parseInt(code, 10)); } catch (e) { return "&#" + code + ";"; }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
      try { return String.fromCodePoint(parseInt(code, 16)); } catch (e) { return "&#x" + code + ";"; }
    });
}

const ATTR_RE = /([a-zA-Z_:][-\w:.]{0,39})\s{0,20}=\s{0,20}(?:"([^"]*)"|'([^']*)'|([^\s"'>]{1,1000}))/g;
function parseAttrs(tag) {
  const attrs = Object.create(null);
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(tag))) {
    const k = m[1].toLowerCase();
    if (!(k in attrs)) attrs[k] = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
  }
  return attrs;
}

// Возвращает { metas: {ключ: значение}, title } — ключи нижним регистром (property/name).
function scanHtml(html) {
  const metas = Object.create(null);
  let title = "";
  let titleDone = false;
  let seen = 0;
  let gt = -2; // кэш позиции ближайшего «>» — без него файл из «<meta » без «>» давал бы квадратичный поиск
  const nextGt = (from) => {
    if (gt === -1) return -1;
    if (gt < from) gt = html.indexOf(">", from);
    return gt;
  };
  let i = html.indexOf("<");
  while (i !== -1) {
    const head = html.substr(i + 1, 6).toLowerCase();
    if (head.startsWith("meta") && !/^meta[a-z0-9_-]/.test(head)) {
      if (++seen > MAX_META_TAGS && titleDone) break;
      if (seen <= MAX_META_TAGS) {
        const end = nextGt(i);
        if (end === -1) { if (titleDone) break; }
        else if (end - i <= MAX_TAG_LEN) {
          const attrs = parseAttrs(html.slice(i + 5, end));
          const content = attrs.content;
          if (content !== undefined) {
            for (const k of [attrs.property, attrs.name]) {
              if (typeof k !== "string") continue;
              const key = k.toLowerCase().trim();
              if (key.length <= 40 && !metas[key]) metas[key] = decodeHtmlEntities(content.slice(0, 2000)).trim();
            }
          }
        }
      }
    } else if (!titleDone && head.startsWith("title") && !/^title[a-z0-9_-]/.test(head)) {
      titleDone = true; // берём только первый <title>
      const end = nextGt(i);
      if (end !== -1) {
        const close = html.indexOf("<", end + 1);
        if (close !== -1 && close - end <= MAX_TITLE_LEN && html.substr(close, 8).toLowerCase() === "</title>") {
          title = decodeHtmlEntities(html.slice(end + 1, close)).trim();
        }
      }
    }
    i = html.indexOf("<", i + 1);
  }
  return { metas, title };
}

function extractMeta(html, targetUrl) {
  const { metas, title: titleTag } = scanHtml(String(html || ""));
  const ogTitle = metas["og:title"] || "";
  const ogDesc = metas["og:description"] || "";
  const ogImage = metas["og:image"] || "";
  const ogSite = metas["og:site_name"] || "";
  const plainDesc = metas["description"] || "";

  const title = ogTitle || titleTag || "";
  const description = ogDesc || plainDesc || "";
  let image = ogImage;
  if (image) {
    try { image = new URL(image, targetUrl).toString(); } catch (e) { image = ""; }
    if (!/^https?:\/\//i.test(image)) image = "";
  }
  let siteName = ogSite || "";
  if (!siteName) { try { siteName = new URL(targetUrl).hostname.replace(/^www\./, ""); } catch (e) {} }

  if (!title && !description && !image) return null;
  return {
    url: targetUrl,
    title: title.slice(0, 200),
    description: description.slice(0, 300),
    image: image.slice(0, 2000),
    siteName: siteName.slice(0, 100),
  };
}

module.exports = { extractMeta, decodeHtmlEntities, scanHtml };
