import { jsonError, jsonOk } from "@/lib/utils";
import { isCronSecretAuthorized } from "@/lib/utils/cron-auth";
import { requireRole } from "@/lib/auth-ucw";
import { reconcileFailedOnChainReleases } from "@/lib/reconcile/onchain-release";

/**
 * Triggers one pass of the on-chain release/refund reconciliation job.
 *
 * Picks up orders + wl_deals stuck in *_pending or *_failed on-chain states
 * (release_pending, refund_pending, release_failed, refund_failed) and:
 *   - polls Circle for tx state when a circle_tx_id exists, or
 *   - retries the on-chain release/refund call up to MAX_RETRIES (5).
 *
 * Writes a RECONCILE_DRIFT audit row when an entity hits the retry cap so ops
 * get paged. Idempotent: terminal states (RELEASED/REFUNDED set by the indexer)
 * are excluded from the scan set.
 *
 * Auth (either):
 *   - Cron secret via `Authorization: Bearer <INDEXER_CRON_SECRET>` OR the
 *     `?cron_secret=<INDEXER_CRON_SECRET>` query param (Vercel's scheduler
 *     sends neither an auth header nor a session cookie), compared
 *     timing-safely (lib/utils/cron-auth.ts), OR
 *   - Admin session (requireRole) — for manual runs from the dashboard.
 *
 * Intended to run every 5 minutes via cron.
 */
export async function POST(req: Request) {
  // .F-fix — Vercel's scheduler sends no auth header and no session
  // cookie, so the secret must also be accepted as ?cron_secret=. The compare
  // is timing-safe (lib/utils/cron-auth.ts). x-vercel-cron alone is never
  // sufficient (spoofable off-Vercel); the secret stays required.
  if (!isCronSecretAuthorized(req, process.env.INDEXER_CRON_SECRET)) {
    try {
      await requireRole("Admin");
    } catch {
      return jsonError("Unauthorized: admin session or cron secret required", 401);
    }
  }

  try {
    const result = await reconcileFailedOnChainReleases();
    return jsonOk(result);
  } catch (e) {
    return jsonError(`reconcile on-chain releases failed: ${(e as Error).message}`, 500);
  }
}

// .B — Vercel Cron issues GET; expose the POST handler under GET too.
export { POST as GET };
