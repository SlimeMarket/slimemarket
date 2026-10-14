/**
 * Run every scheduled job once and report status AND result body.
 *
 * Jobs are the least-exercised code in the system: nothing in normal usage
 * triggers them, and a cron that reports `{"scanned":0}` forever looks healthy
 * while doing nothing. So each job is called directly here and its full result
 * is printed — a job that "succeeds" with a suspiciously empty result is the
 * signal to look closer.
 *
 * Usage: node --env-file=.env.local --import tsx scripts/run-jobs.ts
 */
import { cleanupExpiredDrafts } from "@/lib/order/draft-cleanup";
import { sweepDanglingAllowances } from "@/lib/order/allowance-sweep";
import { reconcileMissingOnchainIds } from "@/lib/reconcile/onchain-ids";
import { runIndexerOnce } from "@/lib/contracts/indexer";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";

type Job = { name: string; run: () => Promise<unknown> };

const jobs: Job[] = [
  { name: "draft-cleanup", run: () => cleanupExpiredDrafts() },
  { name: "allowance-sweep", run: () => sweepDanglingAllowances() },
  { name: "reconcile-onchain-ids", run: () => reconcileMissingOnchainIds() },
  { name: "indexer", run: () => runIndexerOnce() },
];

async function main() {
  const admin = supabaseAdminClient();
  let failed = 0;

  console.log("=== Running all jobs once ===\n");

  for (const job of jobs) {
    const started = Date.now();
    try {
      const result = await job.run();
      const ms = Date.now() - started;
      const body = JSON.stringify(result ?? null);
      console.log(`✅ ${job.name.padEnd(22)} ${ms}ms`);
      console.log(`   ${body.slice(0, 300)}`);
      // A job that returns an explicit error field did NOT succeed.
      if (result && typeof result === "object" && "error" in result && (result as { error?: unknown }).error) {
        console.log(`   ⚠️  result contains an error — check logs`);
        failed++;
      }
    } catch (e) {
      failed++;
      console.log(`❌ ${job.name.padEnd(22)} THROW`);
      console.log(`   ${e instanceof Error ? e.message : String(e)}`);
    }
    console.log("");
  }

  // After the jobs, verify the state they are supposed to maintain.
  console.log("--- state after jobs ---");
  const { data: indexer } = await admin.from("indexer_state").select("*");
  console.log(`indexer_state rows: ${indexer?.length ?? 0}`);
  if (indexer?.length) {
    for (const r of indexer) {
      console.log(`   ${JSON.stringify(r).slice(0, 200)}`);
    }
  } else {
    console.log("   ⚠️  empty — indexer has never saved its position");
    failed++;
  }

  for (const t of ["orders", "wl_deals"]) {
    const { data } = await admin.from(t).select("status");
    const counts: Record<string, number> = {};
    for (const r of data ?? []) counts[r.status] = (counts[r.status] ?? 0) + 1;
    console.log(`${t}: ${JSON.stringify(counts)}`);
  }

  console.log(`\n=== ${failed === 0 ? "ALL JOBS OK" : `${failed} JOB(S) FAILED`} ===`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("\njob runner failed:", e.message || e);
  process.exit(1);
});
