/**
 * bootstrap the FIRST admin account.
 *
 * WHY THIS EXISTS: a fresh database has NO admin at all.
 *   - `0009_wl_m4.sql` seeded a dev admin (`admin@mvp.local` / `Admin123!`), and
 *     `0064_remove_seeded_admin.sql` deliberately deletes it (a publicly known
 *     credential on an Admin account is a standing backdoor).
 *   - `supabase/seed.sql` is disabled (`[db.seed] enabled = false`) and its rows
 *     use fake `auth_id` UUIDs that cannot log in.
 *   - Every admin route requires an EXISTING admin to mint the action token, so
 *     there is no in-app path to the first one.
 *
 * Without this, a fresh deploy cannot approve sellers, resolve disputes, promote
 * middlemen, or collect fees — the platform is unusable.
 *
 * SAFETY: refuses to run when an Admin already exists unless `--force` is passed,
 * so it cannot be used to silently escalate an account on a live database.
 *
 * Usage:
 *   node --env-file=.env.local --import tsx scripts/bootstrap-admin.ts <email-or-uid>
 *   node --env-file=.env.local --import tsx scripts/bootstrap-admin.ts <email> --force
 */
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("✗ Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY (load .env.local).");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const PROMOTE_TO = "Admin";

function fail(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const identifier = args.find((a) => !a.startsWith("--"));

  if (!identifier) fail("Usage: bootstrap-admin.ts <email-or-uid> [--force]");

  // 1. Refuse to escalate on a database that already has an admin.
  const { data: existing, error: existingErr } = await supabase
    .from("users")
    .select("id, email, uid, role")
    .eq("role", PROMOTE_TO)
    .limit(5);

  if (existingErr) fail(`could not read users: ${existingErr.message}`);

  if ((existing ?? []).length > 0 && !force) {
    console.error("\nThis database already has an Admin account:");
    for (const u of existing ?? []) {
      console.error(`  - ${u.email ?? "(no email)"} (uid ${u.uid ?? "?"})`);
    }
    fail(
      "Refusing to promote another admin. Pass --force if you really mean it " +
      "(e.g. recovering a locked-out install).",
    );
  }

  // 2. The account must already exist — it is created by the normal Circle-UCW
  //    signup, so the person can actually receive the OTP and log in.
  const isEmail = identifier.includes("@");
  const { data: target, error: findErr } = await supabase
    .from("users")
    .select("id, email, uid, role")
    .eq(isEmail ? "email" : "uid", identifier)
    .maybeSingle();

  if (findErr) fail(`lookup failed: ${findErr.message}`);
  if (!target) {
    fail(
      `no user found with ${isEmail ? "email" : "uid"} "${identifier}".\n` +
      "Sign that account up through the app first (Circle email OTP), then re-run this script.",
    );
  }

  if (target.role === PROMOTE_TO) {
    console.log(`\n✓ ${target.email ?? target.uid} is already an Admin. Nothing to do.\n`);
    return;
  }

  // 3. Promote.
  const oldRole = target.role;
  const { error: updateErr } = await supabase
    .from("users")
    .update({ role: PROMOTE_TO })
    .eq("id", target.id);
  if (updateErr) fail(`promote failed: ${updateErr.message}`);

  // 4. Leave a trail — an out-of-band role change must be auditable. Both logs
  //    mirror what app/api/admin/users/[id]/role does for the same transition.
  const { error: mmAuditErr } = await supabase.from("mm_audit_log").insert({
    mm_user_id: null,
    mm_wallet_id: "system",
    actor_type: "system",
    action: "MM_PROMOTE",
    ref_id: target.id,
    detail: { oldRole, newRole: PROMOTE_TO, via: "scripts/bootstrap-admin.ts", forced: force },
  });
  if (mmAuditErr) console.warn(`  ! mm_audit_log write failed (non-fatal): ${mmAuditErr.message}`);

  const { error: auditErr } = await supabase.from("audit_log").insert({
    actor_id: null,
    action: "APPROVE",
    ref: target.id,
    detail: { oldRole, newRole: PROMOTE_TO, via: "scripts/bootstrap-admin.ts", forced: force },
  });
  if (auditErr) console.warn(`  ! audit_log write failed (non-fatal): ${auditErr.message}`);

  console.log(`\n✓ Promoted ${target.email ?? target.uid} (${oldRole} → ${PROMOTE_TO})`);
  console.log("  Next: sign in, open the Admin console, and set an admin PIN —");
  console.log("  it is required for sensitive actions like fee collection.\n");
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
