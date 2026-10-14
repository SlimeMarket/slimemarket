/**
 * backfill-dispute-briefs.ts — generate the arbitrator brief for deals that were
 * disputed BEFORE migration 0090 added the columns.
 *
 * Those rows have `disputed_at` set but `dispute_brief` NULL, so the deal room
 * shows no case file for them. This walks every DISPUTED deal without a brief
 * and builds one. Idempotent: re-running only touches rows still missing it.
 *
 * Usage: node --env-file=.env.local --import tsx scripts/tools/backfill-dispute-briefs.ts
 */
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { refreshDisputeBrief } from "@/lib/wl/transitions";

async function main() {
  const admin = supabaseAdminClient();

  const { data: rows, error } = await admin
    .from("wl_deals")
    .select("id, status, disputed_at, dispute_brief")
    .eq("status", "DISPUTED")
    .is("dispute_brief", null);

  if (error) {
    console.error("query failed:", error.message);
    process.exit(1);
  }

  if (!rows?.length) {
    console.log("no disputed deals missing a brief — nothing to do");
    process.exit(0);
  }

  console.log(`${rows.length} disputed deal(s) missing a brief\n`);
  let ok = 0;
  for (const r of rows) {
    try {
      await refreshDisputeBrief(r.id as string);
      console.log(`  ✓ ${r.id}`);
      ok++;
    } catch (e) {
      console.log(`  ✗ ${r.id} — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`\n${ok}/${rows.length} backfilled`);
  process.exit(ok === rows.length ? 0 : 1);
}

main();
