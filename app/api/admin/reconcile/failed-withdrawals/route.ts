import { jsonError, jsonOk } from "@/lib/utils";
import { isCronSecretAuthorized } from "@/lib/utils/cron-auth";
import { requireRole } from "@/lib/auth-ucw";
import { reconcileFailedWithdrawals, reconcileStaleUcwSends } from "@/lib/wallet/reconcile";

/**
 * Triggers one pass of the wallet_txs reconciliation job.
 *
 * Closes the money-loss gap in earnings-withdraw: if the server crashed between
 * sendUsdc (CONFIRMED) and debit_wallet_atomic, the user's ledger was never
 * debited while the USDC left the treasury. This job detects such rows and
 * completes the debit (or reverses if the on-chain tx failed).
 *
 * Also handles pre-Phase-1.2 wallet_txs rows in the old flow that were marked
 * 'failed' with a USDC debit already applied — credit_wallet_atomic reverses.
 *
 * Auth (either):
 *   - Cron secret via `Authorization: Bearer <INDEXER_CRON_SECRET>` OR the
 *     `?cron_secret=<INDEXER_CRON_SECRET>` query param (Vercel's scheduler
 *     sends neither an auth header nor a session cookie), compared
 *     timing-safely (lib/utils/cron-auth.ts), OR
 *   - Admin session (requireRole) — for manual runs from the dashboard.
 *
 * Idempotent: safe to call repeatedly; rows already in 'done'/'failed' are
 * skipped. Intended to run every 5 minutes via cron.
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
    // also sweep UCW-challenge withdrawals that never came back (the FE
    // is supposed to settle them after the user approves; if the browser dies the
    // row is otherwise invisible to every reconciler).
    const [result, staleUcw] = await Promise.all([
      reconcileFailedWithdrawals(),
      reconcileStaleUcwSends().catch((e) => {
        console.error("reconcileStaleUcwSends failed:", e);
        return { scanned: 0, flagged: 0 };
      }),
    ]);
    return jsonOk({ ...result, staleUcw });
  } catch (e) {
    return jsonError(`reconcile failed: ${(e as Error).message}`, 500);
  }
}

// .B — Vercel Cron issues GET; expose the POST handler under GET too.
export { POST as GET };
