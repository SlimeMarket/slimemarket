#!/usr/bin/env node
/**
 * Dump the live public-schema column list to `.secrets/_schema.json`.
 *
 * WHY THIS EXISTS
 * ---------------
 * `scripts/check-select-columns.mjs` validates every `.select()` / `.update()`
 * against that snapshot. The snapshot was generated ad-hoc on 2026-10-01 and had
 * already drifted: migrations 0090+ added `wl_deals.dispute_reason`,
 * `dispute_evidence`, `dispute_brief` and `dispute_brief_at`, so the checker
 * reported four phantom "column does not exist" errors. A noisy checker gets
 * ignored, and an ignored checker hides the real ones.
 *
 * Regenerate this whenever migrations land — ideally in the same commit.
 *
 * Usage:
 *   node scripts/tools/dump-schema.mjs
 *
 * Env overrides (defaults match the local Supabase Docker stack):
 *   SUPABASE_DB_CONTAINER   default supabase_db_slimemarket
 *   SUPABASE_DB_NAME        default postgres
 *   SUPABASE_DB_USER        default postgres
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? "supabase_db_slimemarket";
const DB = process.env.SUPABASE_DB_NAME ?? "postgres";
const USER = process.env.SUPABASE_DB_USER ?? "postgres";
const OUT = ".secrets/_schema.json";
const OUT_ENUMS = ".secrets/_enums.json";

/**
 * Run one single-line query against the local Supabase Postgres and return the
 * stdout. Single-line because psql's `-c` and the project's own tooling both
 * choke on embedded newlines.
 */
function psql(sql) {
  try {
    return execFileSync(
      "docker",
      ["exec", "-i", CONTAINER, "psql", "-U", USER, "-d", DB, "-tAc", sql],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (e) {
    const detail = e.stderr?.toString?.() || e.message;
    console.error(`✗ could not read from ${CONTAINER}:\n${detail}`);
    console.error("  Is the local Supabase stack running?  docker ps");
    process.exit(1);
  }
}

// One row per column, `table|column`, so the whole schema arrives as flat text
// — no JSON parsing inside psql, and no locale/format surprises.
const SQL =
  "select table_name || '|' || column_name from information_schema.columns " +
  "where table_schema = 'public' order by table_name, ordinal_position;";

const raw = psql(SQL);

/** @type {Record<string, string[]>} */
const schema = {};
for (const line of raw.split("\n")) {
  const [table, column] = line.trim().split("|");
  if (!table || !column) continue;
  (schema[table] ??= []).push(column);
}

const tables = Object.keys(schema);
if (tables.length === 0) {
  console.error("✗ the schema came back empty — refusing to overwrite the snapshot");
  process.exit(1);
}

mkdirSync(".secrets", { recursive: true });
writeFileSync(OUT, JSON.stringify(schema, null, 2) + "\n");

const columns = tables.reduce((n, t) => n + schema[t].length, 0);
console.log(`✓ wrote ${OUT} — ${tables.length} tables, ${columns} columns`);

// ---------------------------------------------------------------------------
// Enum snapshots — the CHECK constraints, so the checker can also catch a
// write that uses a value the constraint rejects.
//
// This half is the one that bit us: the snapshot was regenerated for columns
// but not for enums, so the checker still believed `wl_deals.status` was
// `MENUNGGU|SELESAI|BATAL` long after migrations 0086/0087/0089 renamed those
// to English. Keep the two in one script so they can never diverge again.
//
// Query returns `table|constraintdef`; the definition is parsed here rather
// than in SQL because `regexp_matches(..., 'g')` inside a scalar subquery is
// far more fragile than a few lines of JS.
// ---------------------------------------------------------------------------
const enumRows = psql(
  "select c.relname || '|' || pg_get_constraintdef(con.oid) from pg_constraint con " +
    "join pg_class c on c.oid = con.conrelid " +
    "join pg_namespace n on n.oid = c.relnamespace " +
    "where n.nspname = 'public' and con.contype = 'c' " +
    "and pg_get_constraintdef(con.oid) like '% = ANY (ARRAY%' order by 1;",
);

/** @type {Record<string, Record<string, string[]>>} */
const enums = {};
for (const line of enumRows.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  const sep = trimmed.indexOf("|");
  if (sep < 0) continue;
  const table = trimmed.slice(0, sep);
  const def = trimmed.slice(sep + 1);

  // `CHECK ((status = ANY (ARRAY['A'::text, 'B'::text])))`
  const colMatch = def.match(/\(\s*"?([a-z_][a-z0-9_]*)"?\s*=\s*ANY/);
  if (!colMatch) continue;
  const column = colMatch[1];

  const values = [...def.matchAll(/'([^']*)'::text/g)].map((m) => m[1]);
  if (values.length === 0) continue;

  (enums[table] ??= {})[column] = values;
}

const enumTables = Object.keys(enums);
const enumCount = enumTables.reduce((n, t) => n + Object.keys(enums[t]).length, 0);
if (enumCount === 0) {
  console.error("✗ no enum constraints found — refusing to overwrite the snapshot");
  process.exit(1);
}
writeFileSync(OUT_ENUMS, JSON.stringify(enums, null, 2) + "\n");
console.log(`✓ wrote ${OUT_ENUMS} — ${enumTables.length} tables, ${enumCount} enum columns`);
