import { jsonError, jsonOk } from "@/lib/utils";
import { isCronSecretAuthorized } from "@/lib/utils/cron-auth";
import { requireRole } from "@/lib/auth-ucw";
import { runIndexerOnce } from "@/lib/contracts/indexer";

/**
 * Triggers one bounded pass of the escrow reconciliation indexer.
 *
 * Auth (either):
 *   - Cron secret via `Authorization: Bearer <INDEXER_CRON_SECRET>` OR the
 *     `?cron_secret=<INDEXER_CRON_SECRET>` query param (Vercel's scheduler
 *     sends neither an auth header nor a session cookie), compared
 *     timing-safely (lib/utils/cron-auth.ts), OR
 *   - Admin session (requireRole) — for manual runs from the dashboard.
 *
 * Idempotent: safe to call repeatedly; advances `indexer_state.last_processed_block`.
 * Intended to be called on a short interval (e.g. every 15–30s) by a cron/worker.
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
    const result = await runIndexerOnce();
    return jsonOk(result);
  } catch (e) {
    return jsonError(`indexer run failed: ${(e as Error).message}`, 500);
  }
}

// .B — Vercel Cron issues GET; expose the POST handler under GET too.
export { POST as GET };
