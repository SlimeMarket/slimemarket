/**
 * Apply a multi-statement SQL file to the local Supabase DB.
 *
 * `supabase db query --file` refuses more than one command per call
 * ("cannot insert multiple commands into a prepared statement"), and
 * `supabase db reset` fails here because `schema_migrations` already has rows
 * the reset wants to re-insert. So send the file in one go over a plain
 * connection — Postgres accepts multiple statements in a single simple query.
 *
 * Run: node scripts/apply-sql.mjs <file>
 */
import { readFileSync } from "node:fs";
import pg from "pg";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/apply-sql.mjs <file>");
  process.exit(1);
}

const sql = readFileSync(file, "utf8");
const client = new pg.Client({
  connectionString:
    process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
});

await client.connect();
try {
  await client.query(sql);
  console.log("OK — applied", file);
} catch (e) {
  console.error("gagal:", e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
