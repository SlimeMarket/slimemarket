// Throwaway helper: split a multi-statement .sql file into one file per
// statement under .secrets/_sqlsplit/, so each can be applied individually with
// `supabase db query -f` (which rejects multi-command input).
//
// Splits on top-level semicolons only — semicolons inside $$ ... $$ blocks
// (PL/pgSQL bodies) are preserved.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const file = process.argv[2];
if (!file) {
  console.error("usage: node split-sql.mjs <file.sql>");
  process.exit(1);
}

const OUT = resolve(".secrets/_sqlsplit");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// Strip line comments so a `;` inside a comment cannot split a statement.
const stripped = readFileSync(file, "utf8")
  .split("\n")
  .map((l) => (l.trimStart().startsWith("--") ? "" : l))
  .join("\n");

const statements = [];
let buf = "";
let inDollar = false;
for (let i = 0; i < stripped.length; i++) {
  if (stripped.startsWith("$$", i)) {
    inDollar = !inDollar;
    buf += "$$";
    i++;
    continue;
  }
  const ch = stripped[i];
  if (ch === ";" && !inDollar) {
    if (buf.trim()) statements.push(buf.trim());
    buf = "";
    continue;
  }
  buf += ch;
}
if (buf.trim()) statements.push(buf.trim());

statements.forEach((s, i) => {
  const name = `stmt-${String(i + 1).padStart(2, "0")}.sql`;
  writeFileSync(resolve(OUT, name), s + ";\n", "utf8");
  console.log(`${name}  ${s.split("\n")[0].slice(0, 76)}`);
});
console.log(`\n${statements.length} statements written to ${OUT}`);
