// Extract English keys missing from the Indonesian i18n block.
const fs = require("fs");
const src = fs.readFileSync("public/i18n.jsx", "utf8");

function block(lang) {
  const start = src.indexOf("  " + lang + ": {");
  if (start < 0) return "";
  const rest = src.slice(start + 10);
  const candidates = ["\n  id: {", "\n  zh: {", "\n  ru: {", "\n  en: {", "\n};"];
  let end = Infinity;
  for (const t of candidates) {
    const i = rest.indexOf(t);
    if (i >= 0 && i < end) end = i;
  }
  return src.slice(start, start + 10 + (end === Infinity ? rest.length : end));
}

const KEY_RE = /'([a-zA-Z0-9_.]+)':\s*'((?:[^'\\]|\\.)*)'/g;
function keys(b) {
  return [...b.matchAll(KEY_RE)].map((m) => m[1]);
}

const en = keys(block("en"));
const id = keys(block("id"));
const missing = en.filter((k) => !id.includes(k));
console.log("en:", en.length, "id:", id.length, "missing in id:", missing.length);

// en key -> value map for context
const enBlock = block("en");
const map = {};
for (const m of enBlock.matchAll(KEY_RE)) map[m[1]] = m[2];

const pairs = {};
for (const k of missing) pairs[k] = map[k] ?? "?";
fs.writeFileSync("missing-id-pairs.json", JSON.stringify(pairs, null, 2));
console.log("written missing-id-pairs.json");
