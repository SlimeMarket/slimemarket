import { jsonError, jsonOk } from "@/lib/utils";
import { isCronSecretAuthorized } from "@/lib/utils/cron-auth";
import { requireRole } from "@/lib/auth-ucw";
import { runAutoReleaseOnce } from "@/lib/order/auto-settlement";

/**
 * .E — SELLER AUTO-SETTLEMENT cron: the 42h auto-release pass.
 *
 * Flips every overdue SENT order (release_deadline < now, 42h inspection
 * window) to DONE and IMMEDIATELY relays releaseOrder on-chain, so the seller
 * is paid without waiting for the buyer to confirm and without any manual
 * claim or admin trigger. Release failures are tracked release_failed and
 * retried by /api/admin/reconcile/onchain-releases.
 *
 * Auth (either):
 *   - Cron secret via `Authorization: Bearer <INDEXER_CRON_SECRET>` OR the
 *     `?cron_secret=<INDEXER_CRON_SECRET>` query param (Vercel's scheduler
 *     sends neither an auth header nor a session cookie), compared
 *     timing-safely (lib/utils/cron-auth.ts), OR
 *   - Admin session (requireRole) — for manual runs from the dashboard.
 *
 * Idempotent: the atomic RPC only touches SENT rows; terminal on-chain states
 * are skipped. Intended to run every 5 minutes via cron (scripts/scheduler.js).
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
    const result = await runAutoReleaseOnce();
    return jsonOk(result);
  } catch (e) {
    return jsonError(`auto-release failed: ${(e as Error).message}`, 500);
  }
}

// .B — Vercel Cron issues GET; expose the POST handler under GET too.
export { POST as GET };
