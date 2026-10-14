/**
 * List migrations and print the exact command to apply them to the LOCAL
 * Supabase Docker database.
 *
 * WHY THIS EXISTS
 * ---------------
 * This project has no `supabase` CLI and no `psql` on PATH, so there was no
 * documented way to apply a new migration locally. That is how a migration ends
 * up written but never run — migration 0070 sat unapplied until it was done by
 * hand.
 *
 * WHY IT ONLY PRINTS
 * ------------------
 * The obvious implementation shells out to `docker exec … psql`. That was tried
 * and abandoned: in restricted environments Node cannot spawn `docker.exe` at
 * all (spawnSync fails with EBUSY, with or without `shell: true`, and outside the
 * sandbox too), while the same command works fine from a normal terminal. Rather
 * than ship an execution path that silently fails for some users, this script
 * does the part that is always reliable — resolve the file, then hand you a
 * command you can paste — and you run it in a real shell.
 *
 * Usage:
 *   node scripts/migrations.mjs                 # list all
 *   node scripts/migrations.mjs --from 0070     # command for 0070 and later
 *   node scripts/migrations.mjs 0070            # command for one migration
 *   node scripts/migrations.mjs --from 0070 --print-sql   # + cat the SQL too
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const CONTAINER = process.env.SUPABASE_DB_CONTAINER || "supabase_db_slimemarket";
const DB_USER = process.env.SUPABASE_DB_USER || "postgres";
const DB_NAME = process.env.SUPABASE_DB_NAME || "postgres";
const DIR = "supabase/migrations";

const args = process.argv.slice(2);
const PRINT_SQL = args.includes("--print-sql");

/** All `NNNN_*.sql` migrations, filename order. */
function migrations() {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

const all = migrations();
const numbered = all.filter((f) => /^\d{4}_/.test(f));

function show(files) {
  console.log(`${files.length} migration(s) will be applied:\n`);
  for (const f of files) console.log(`  ${f}`);
  console.log("\nRun (one by one, in order):\n");
  for (const f of files) {
    console.log(
      `  docker exec -i ${CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} -v ON_ERROR_STOP=1 < ${DIR}/${f}`,
    );
  }
  if (PRINT_SQL) {
    console.log("\nFile contents:");
    for (const f of files) {
      console.log(`\n----- ${f} -----`);
      console.log(readFileSync(join(DIR, f), "utf8"));
    }
  }
  console.log(
    "\nNotes:\n" +
      "  - `-v ON_ERROR_STOP=1` makes psql stop at the first error.\n" +
      "  - Migrations are written idempotently (create or replace / if not exists), but\n" +
      "    data migrations should only be run once.\n" +
      "  - Check the container: `docker ps --filter name=supabase_db`.",
  );
}

if (args.length === 0 || args.includes("--list")) {
  console.log(`${all.length} migration(s) in ${DIR}:\n`);
  for (const f of all) console.log(`  ${f}`);
  console.log("\nUsage: node scripts/migrations.mjs --from 0070   (or: 0070)");
  process.exit(0);
}

const fromIdx = args.indexOf("--from");
if (fromIdx !== -1) {
  const from = (args[fromIdx + 1] || "").padStart(4, "0");
  if (!/^\d{4}$/.test(from)) {
    console.error("--from needs 4 digits, e.g.: --from 0070");
    process.exit(1);
  }
  // Match the exact `NNNN_` prefix — a bare string compare would also pull in
  // date-named files such as `20260811_...` (first four chars "2026").
  const files = numbered.filter((f) => f.slice(0, 4) >= from);
  if (!files.length) {
    console.error(`No migrations >= ${from}.`);
    process.exit(1);
  }
  show(files);
  process.exit(0);
}

// A bare 4-digit number, or an explicit filename.
const target = args.find((a) => !a.startsWith("--"));
const file = /^\d{4}$/.test(target)
  ? numbered.find((f) => f.startsWith(target))
  : all.find((f) => f === target || f.startsWith(target));

if (!file) {
  console.error(`Migration not found: ${target}`);
  process.exit(1);
}
if (!existsSync(join(DIR, file))) {
  console.error(`File missing: ${join(DIR, file)}`);
  process.exit(1);
}
show([file]);
