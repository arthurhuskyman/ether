// Общие помощники для tests/fix80-fuzz-*.test.js: детерминированный ГПСЧ (mulberry32), генераторы мусора, таймаут.
function rng(seed) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const o = { next, int: (n) => Math.floor(next() * n), bool: () => next() < 0.5, pick: (arr) => arr[Math.floor(next() * arr.length)] };
  return o;
}
const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_+/=%.:#&?{}[]\"' \n\t\u0000‮🙂é";
function junkString(r, n) { let s = ""; for (let i = 0; i < n; i++) s += ALPHA[r.int(ALPHA.length)]; return s; }
function withTimeout(p, ms, msg) { let t; return Promise.race([Promise.resolve(p), new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg || "timeout")), ms); })]).finally(() => clearTimeout(t)); }
// Случайное «JSON-подобное» значение: примитивы всех типов, вложенность, опасные ключи, огромные строки.
function junkValue(r, depth) {
  depth = depth || 0;
  const k = r.int(depth > 2 ? 9 : 12);
  switch (k) {
    case 0: return null; case 1: return undefined; case 2: return r.bool(); case 3: return r.int(2000000) - 1000000;
    case 4: return [NaN, Infinity, -Infinity, -0, 1e308, Number.MAX_SAFE_INTEGER + 2][r.int(6)];
    case 5: return junkString(r, r.int(40)); case 6: return "x".repeat(1 + r.int(70000)); case 7: return ""; case 8: return ["__proto__", "constructor", "toString"][r.int(3)];
    case 9: { const a = []; const n = r.int(6); for (let i = 0; i < n; i++) a.push(junkValue(r, depth + 1)); return a; }
    case 10: { const o = {}; const n = r.int(6); for (let i = 0; i < n; i++) o[r.bool() ? junkString(r, 1 + r.int(8)) : ["id", "text", "name", "size", "mime", "ts", "kind"][r.int(7)]] = junkValue(r, depth + 1); return o; }
    default: return JSON.parse('{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}}}');
  }
}
module.exports = { rng, junkString, junkValue, withTimeout };
