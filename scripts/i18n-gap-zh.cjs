// Compute keys present in en but missing in a target lang, and emit en+id
// values so zh/ru translations can be authored against known-good text.
const fs = require("fs");
const src = fs.readFileSync("public/i18n.jsx", "utf8");
const KEY_RE = /(['"])([a-zA-Z0-9_.]+)\1:\s*(['"])((?:[^'"\\]|\\.)*?)\3/g;
function block(lang) {
  const start = src.indexOf("  " + lang + ": {");
  const rest = src.slice(start + 10);
  const ends = ["\n  id: {", "\n  zh: {", "\n  ru: {", "\n  en: {", "\n};"];
  let end = Infinity;
  for (const t of ends) { const i = rest.indexOf(t); if (i >= 0 && i < end) end = i; }
  return src.slice(start, start + 10 + (end === Infinity ? rest.length : end));
}
function map(b) { const m = {}; for (const x of b.matchAll(KEY_RE)) m[x[2]] = x[4]; return m; }
const en = map(block("en"));
const id = map(block("id"));
const zh = map(block("zh"));
const ru = map(block("ru"));
const missZh = Object.keys(en).filter((k) => !(k in zh));
const missRu = Object.keys(en).filter((k) => !(k in ru));
console.log(JSON.stringify({
  enCount: Object.keys(en).length,
  idCount: Object.keys(id).length,
  zhCount: Object.keys(zh).length,
  ruCount: Object.keys(ru).length,
  missZh,
  missRu,
  ref: Object.fromEntries(missZh.map((k) => [k, { en: en[k], id: id[k] ?? "" }])),
}, null, 2));
