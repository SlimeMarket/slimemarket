/**
 * Cross-check every PostgREST `.select("...")` against the REAL database schema.
 *
 * WHY: a `.select("a, b")` naming a column that does not exist makes PostgREST
 * error, the row come back null, and the handler answer 404 — for every user,
 * silently. Unit tests never catch it because they mock the DB layer, which is
 * exactly the layer that breaks.
 *
 * Reads .secrets/_schema.json (dumped from information_schema) and walks every
 * .ts file under app/ and lib/.
 *
 * Usage: node scripts/check-select-columns.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const schema = JSON.parse(readFileSync(".secrets/_schema.json", "utf8"));
/** { table: { column: [allowed values] } } — from the live CHECK constraints. */
const enums = JSON.parse(readFileSync(".secrets/_enums.json", "utf8"));

/** Strip PostgREST relation hints: `users!inner` / `users!wl_deals_seller_id_fkey` → `users`. */
const stripHint = (s) => s.replace(/![A-Za-z0-9_]+/g, "");

/**
 * Parse a PostgREST select string into tokens.
 *
 * A token followed by `(` is an EMBEDDED RELATION (`users(...)`, `seller:users!fk(...)`)
 * — its name is a table, not a column, so it must not be checked against this
 * table's columns. Only plain tokens are columns. Getting this wrong produces a
 * wall of false positives that hides the real bugs.
 */
function parseSelect(sel) {
  const out = [];
  let depth = 0, cur = "";
  const push = (raw) => {
    let t = raw.trim();
    if (!t) return;
    const isRelation = t.includes("(");
    // alias:column → the real name is after the colon (applies to both forms)
    const colon = t.indexOf(":");
    if (colon !== -1) t = t.slice(colon + 1).trim();
    const paren = t.indexOf("(");
    if (paren !== -1) t = t.slice(0, paren).trim();
    t = stripHint(t).trim();
    if (!t || t === "*") return;
    out.push({ name: t, isRelation });
  };
  for (const ch of sel) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { push(cur); cur = ""; continue; }
    cur += ch;
  }
  push(cur);
  return out;
}

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p);
  }
  return acc;
}

/**
 * Every `.from("x")` … `.select("…")` pair in a file, in source order.
 *
 * The window is bounded by the next `.from(` or statement terminator: a
 * `.select` further down the file belongs to a DIFFERENT query chain, and
 * counting it produces false positives that bury the real findings.
 */
function findSelects(src) {
  const out = [];
  const fromRe = /\.from\(\s*["'`]([A-Za-z0-9_]+)["'`]\s*\)/g;
  let m;
  while ((m = fromRe.exec(src))) {
    const rest = src.slice(m.index + m[0].length);
    const stopAt = [rest.indexOf(".from("), rest.indexOf(";")]
      .filter((i) => i >= 0);
    const window = stopAt.length ? rest.slice(0, Math.min(...stopAt)) : rest;
    const s = window.match(/\.select\(\s*(`([\s\S]*?)`|"([^"]*)"|'([^']*)')/);
    if (!s) continue;
    const sel = s[2] ?? s[3] ?? s[4] ?? "";
    const line = src.slice(0, m.index).split("\n").length;
    out.push({ table: m[1], sel, line });
  }
  return out;
}

/**
 * Top-level keys of an object literal starting at `start` (index of `{`).
 * Only depth-1 keys are returned — nested objects belong to other tables.
 * String-literal values are captured too, so enum CHECK constraints can be
 * validated (a wrong value fails the write just as hard as a wrong column).
 */
function objectKeys(src, start) {
  const keys = [];
  let depth = 0, i = start, buf = "", expectKey = false, lastKey = null;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") { depth++; if (depth === 1) { expectKey = true; buf = ""; } continue; }
    if (ch === "}") { depth--; if (depth === 0) break; continue; }
    if (depth === 1) {
      if (expectKey) {
        if (ch === ":") {
          const k = buf.trim().replace(/^["'`]|["'`]$/g, "");
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) { keys.push({ name: k, value: null }); lastKey = k; }
          else lastKey = null;
          expectKey = false; buf = "";
        } else if (ch === "," || ch === "(") {
          expectKey = false; buf = ""; lastKey = null;
        } else buf += ch;
      } else if (ch === ",") { expectKey = true; buf = ""; lastKey = null; }
      else if (lastKey && (ch === '"' || ch === "'" || ch === "`")) {
        // Capture a string literal ONLY when it is the WHOLE value (`key: "x"`).
        //
        // A ternary such as
        //     on_chain_status: decision === "refund" ? "refund_pending" : "release_pending"
        // contains literals too, and the first one is a COMPARISON operand. Taking
        // it as the written value reported `"refund"` as an invalid enum on code
        // that is correct — a false positive on a money path, which is exactly
        // how a checker earns the right to be ignored.
        let j = i + 1, val = "";
        while (j < src.length && src[j] !== ch) { val += src[j]; j++; }
        // Peek past whitespace: a bare literal is followed by a delimiter.
        let k = j + 1;
        while (k < src.length && /\s/.test(src[k])) k++;
        const delim = src[k];
        const isBare = delim === "," || delim === "}" || delim === ")";

        const entry = keys[keys.length - 1];
        if (entry && entry.value === null && !val.includes("$") && isBare) {
          entry.value = val;
        } else {
          // An expression, not a literal. Stop looking for this key so a later
          // branch of the ternary is not mistaken for the value either. The
          // value stays null, which means "not checked" — the deliberate
          // trade-off: skipping an unverifiable expression beats crying wolf.
          lastKey = null;
        }
        i = j;
      }
    }
  }
  return keys;
}

/**
 * Find every `.from("t").insert|update|upsert({...})` and its payload keys.
 *
 * The write MUST be in the same chain as the `.from()` — if another `.from(`
 * appears first, the write belongs to that later query. Without this the payload
 * of one table gets attributed to the previous one, producing a wall of bogus
 * findings that hides the real ones.
 */
function findWrites(src) {
  const out = [];
  const fromRe = /\.from\(\s*["'`]([A-Za-z0-9_]+)["'`]\s*\)/g;
  let m;
  while ((m = fromRe.exec(src))) {
    const table = m[1];
    const rest = src.slice(m.index + m[0].length);
    // Only look as far as the next `.from(` — beyond that it's a different query.
    const nextFrom = rest.indexOf(".from(");
    const window = nextFrom === -1 ? rest : rest.slice(0, nextFrom);
    const w = window.match(/\.(insert|update|upsert)\(\s*(\{|\[)/);
    if (!w) continue;
    const braceAt = m.index + m[0].length + w.index + w[0].length - 1;
    const line = src.slice(0, m.index).split("\n").length;
    const start = src[braceAt] === "[" ? src.indexOf("{", braceAt) : braceAt;
    if (start === -1) continue;
    out.push({ table, keys: objectKeys(src, start), line, op: w[1] });
  }
  return out;
}

/** Columns named in `.eq/.neq/.gt/.lt/.gte/.lte/.like/.ilike/.is/.not/.order/.in` calls. */
function findFilters(src) {
  const out = [];
  const re = /\.(eq|neq|gt|gte|lt|lte|like|ilike|is|in|not|order)\(\s*["'`]([A-Za-z0-9_]+)["'`]/g;
  let m;
  while ((m = re.exec(src))) {
    const line = src.slice(0, m.index).split("\n").length;
    // Find the nearest preceding .from() to know the table.
    const before = src.slice(0, m.index);
    const froms = [...before.matchAll(/\.from\(\s*["'`]([A-Za-z0-9_]+)["'`]\s*\)/g)];
    if (!froms.length) continue;
    const table = froms[froms.length - 1][1];
    // Skip if a different .from() starts after the last one (query switched).
    const lastFromEnd = before.lastIndexOf(froms[froms.length - 1][0]) + froms[froms.length - 1][0].length;
    if (/\.from\(/.test(before.slice(lastFromEnd))) continue;
    out.push({ table, col: m[2], line, op: m[1] });
  }
  return out;
}

const files = [...walk("app"), ...walk("lib")];
const problems = [];
let checked = 0;

for (const f of files) {
  const src = readFileSync(f, "utf8");

  for (const { table, sel, line } of findSelects(src)) {
    const cols = schema[table];
    if (!cols) continue;
    for (const { name: col, isRelation } of parseSelect(sel)) {
      if (isRelation) continue;
      checked++;
      if (!cols.includes(col)) {
        problems.push({ file: f, line, table, col, sel: sel.trim().slice(0, 90), kind: "select" });
      }
    }
  }

  for (const { table, keys, line, op } of findWrites(src)) {
    const cols = schema[table];
    if (!cols) continue;
    for (const { name: col, value } of keys) {
      checked++;
      if (!cols.includes(col)) {
        problems.push({ file: f, line, table, col, sel: `(${op} payload)`, kind: op });
        continue;
      }
      // Enum check: a value outside the CHECK constraint fails the write at
      // runtime, which no unit test catches because they mock the DB.
      const allowed = enums[table]?.[col];
      if (allowed && value !== null && !allowed.includes(value)) {
        problems.push({
          file: f, line, table, col,
          sel: `${col}: "${value}"  ← allowed: ${allowed.join(" | ")}`,
          kind: `enum(${op})`,
        });
      }
    }
  }

  for (const { table, col, line, op } of findFilters(src)) {
    const cols = schema[table];
    if (!cols) continue;
    checked++;
    if (!cols.includes(col)) {
      problems.push({ file: f, line, table, col, sel: `.${op}("${col}")`, kind: "filter" });
    }
  }
}

console.log(`Tables in schema : ${Object.keys(schema).length}`);
console.log(`Files scanned    : ${files.length}`);
console.log(`Columns checked  : ${checked}`);
console.log("");

if (problems.length === 0) {
  console.log("✅ All columns & enum values match the schema");
} else {
  console.log(`❌ ${problems.length} problems found:\n`);
  for (const p of problems) {
    if (p.kind.startsWith("enum")) {
      console.log(`  ${p.file}:${p.line}  [${p.kind}]`);
      console.log(`    value outside CHECK constraint on ${p.table}.${p.col}`);
      console.log(`    ${p.sel}`);
    } else {
      console.log(`  ${p.file}:${p.line}  [${p.kind}]`);
      console.log(`    table "${p.table}" has no column "${p.col}"`);
      console.log(`    ${p.sel}`);
    }
  }
  process.exitCode = 1;
}
