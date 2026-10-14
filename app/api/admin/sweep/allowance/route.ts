import { jsonError, jsonOk } from "@/lib/utils";
import { isCronSecretAuthorized } from "@/lib/utils/cron-auth";
import { requireRole } from "@/lib/auth-ucw";
import { sweepDanglingAllowances } from "@/lib/order/allowance-sweep";

/**
 * Triggers one dangling-allowance sweep pass.
 *
 * Detects non-custodial checkout drafts where the buyer approved USDC for the
 * escrow contract but the DCW relayer's `createOrderFor` never confirmed.
 * Marks the order FAILED + notifies the buyer to revoke the allowance.
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
    const result = await sweepDanglingAllowances();
    return jsonOk(result);
  } catch (e) {
    return jsonError(`sweep failed: ${(e as Error).message}`, 500);
  }
}

// .B — Vercel Cron issues GET; expose the POST handler under GET too.
export { POST as GET };
