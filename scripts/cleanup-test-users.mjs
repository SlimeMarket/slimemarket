/**
 * Remove test / junk accounts from the local Supabase database.
 *
 * REWRITTEN. The previous `scripts/cleanup_test_users.js` could never
 * have worked:
 *   - `package.json` declares `"type": "module"`, so a `.js` file is ESM and
 *     `require(...)` throws "require is not defined in ES module scope" on the
 *     very first line;
 *   - it called `supabase.rpc('get_user_ids_by_emails', …)` and then chained
 *     `.eq()` onto the result — no such RPC exists in any migration;
 *   - it required an env var to confirm, but never actually asked.
 *
 * This version is DRY-RUN BY DEFAULT, backs up every row before deleting, and
 * refuses to touch staff accounts unless you explicitly ask for it.
 *
 * Usage:
 *   node scripts/cleanup-test-users.mjs                      # list only
 *   node scripts/cleanup-test-users.mjs --apply              # delete matches
 *   node scripts/cleanup-test-users.mjs --apply --include-staff
 *   node scripts/cleanup-test-users.mjs --apply --email a@b.c --email d@e.f
 *
 * Exit codes: 0 = ok, 1 = error / nothing to do.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

// ---- env (minimal .env.local reader — no dotenv dependency) ---------------
const env = {};
try {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  console.error("Cannot read .env.local — run from the project root.");
  process.exit(1);
}

const SUPABASE_URL = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from .env.local");
  process.exit(1);
}

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const INCLUDE_STAFF = argv.includes("--include-staff");
const EXPLICIT_EMAILS = argv
  .map((a, i) => (a === "--email" ? argv[i + 1] : null))
  .filter(Boolean)
  .map((e) => e.toLowerCase());

/**
 * Patterns that identify a test account. Deliberately conservative: a false
 * positive deletes a real user, so we match explicit markers only.
 */
const TEST_PATTERNS = [
  { re: /^test[._-]?/i, why: 'email starts with "test"' },
  { re: /[._-]test@/i, why: 'email contains ".test@"' },
  { re: /@example\.(com|org|net)$/i, why: "example.com domain" },
  { re: /@catchmail\.io$/i, why: "disposable domain" },
  { re: /@mailinator\.com$/i, why: "disposable domain" },
  { re: /^mmtest@/i, why: 'legacy "mmtest" fixture' },
  { re: /^smprobe\d*@/i, why: "Circle probe account" },
  { re: /@test\./i, why: "test subdomain" },
];

/** Roles that should never be deleted without --include-staff. */
const STAFF_ROLES = new Set(["Admin", "MM"]);

function reasonFor(email) {
  if (EXPLICIT_EMAILS.includes(email.toLowerCase())) return "explicitly requested (--email)";
  for (const p of TEST_PATTERNS) {
    if (p.re.test(email)) return p.why;
  }
  return null;
}

async function sb(path, init = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers ?? {}),
    },
  });
  const text = await r.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

const users = await sb("users?select=*");
if (!Array.isArray(users)) {
  console.error("Failed to read users table:", JSON.stringify(users).slice(0, 300));
  process.exit(1);
}

const targets = [];
const skippedStaff = [];
for (const u of users) {
  const why = reasonFor(u.email ?? "");
  if (!why) continue;
  if (STAFF_ROLES.has(u.role) && !INCLUDE_STAFF) {
    skippedStaff.push({ ...u, why });
    continue;
  }
  targets.push({ ...u, why });
}

console.log(`Total users : ${users.length}`);
console.log(`To delete   : ${targets.length}`);
console.log(`Skipped     : ${skippedStaff.length} (staff accounts — pass --include-staff to include them)`);
console.log("");

if (targets.length) {
  console.log("=== Target ===");
  for (const u of targets) {
    console.log(`  ${u.email}  role=${u.role}  uid=${u.uid}  → ${u.why}`);
  }
}
if (skippedStaff.length) {
  console.log("\n=== Skipped (staff) ===");
  for (const u of skippedStaff) console.log(`  ${u.email}  role=${u.role}  → ${u.why}`);
}

if (!APPLY) {
  console.log("\n(DRY RUN — nothing deleted. Add --apply to execute.)");
  process.exit(targets.length ? 0 : 1);
}

if (!targets.length) {
  console.log("\nNothing to delete.");
  process.exit(1);
}

// ---- backup before deleting ----------------------------------------------
mkdirSync(".secrets", { recursive: true });
const backupPath = `.secrets/user-backup-${Date.now()}.json`;
writeFileSync(backupPath, JSON.stringify(targets, null, 2));
console.log(`\nBackup ${targets.length} row → ${backupPath}`);

// ---- delete ---------------------------------------------------------------
let deleted = 0;
for (const u of targets) {
  try {
    await sb(`users?id=eq.${u.id}`, { method: "DELETE" });
    console.log(`  ✓ deleted: ${u.email}`);
    deleted++;
  } catch (e) {
    console.error(`  ✗ failed to delete ${u.email}: ${e.message}`);
  }
}

const remaining = await sb("users?select=id,email,role");
console.log(`\nDone. deleted=${deleted} remaining=${Array.isArray(remaining) ? remaining.length : "?"}`);
if (Array.isArray(remaining)) {
  for (const u of remaining) console.log(`  remaining: ${u.email} (${u.role})`);
}

console.log(
  "\nNote: UCW users on Circle CANNOT be deleted via the API (there is no delete endpoint).\n" +
    "Delete them manually in Console → Wallets → User Controlled → Users.",
);
process.exit(deleted === targets.length ? 0 : 1);
