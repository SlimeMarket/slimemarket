import { jsonError, jsonOk } from "@/lib/utils";
import { isCronSecretAuthorized } from "@/lib/utils/cron-auth";
import { requireRole } from "@/lib/auth-ucw";
import { reconcileMissingOnchainIds } from "@/lib/reconcile/onchain-ids";

/**
 * Resolves missing on-chain ids for orders / WL deals whose relay WAS submitted.
 *
 * closes the hole where `confirmCheckoutOrder`/`confirmWlDeal` relayed
 * the creation tx but could not read the contract id out of the receipt in time.
 * Those rows keep a NULL `on_chain_order_id`/`on_chain_deal_id` while the buyer's
 * USDC is already in escrow; the indexer correlates by contract id only, so it
 * cannot see them, and the stuck-draft sweep used to cancel them outright.
 * This job reads the creation event from the stored Circle tx and backfills the id.
 *
 * Auth (either): cron secret (Bearer / ?cron_secret=) or an Admin session.
 * Intended to run every 5 minutes via cron.
 */
export async function POST(req: Request) {
  if (!isCronSecretAuthorized(req, process.env.INDEXER_CRON_SECRET)) {
    try {
      await requireRole("Admin");
    } catch {
      return jsonError("Unauthorized: admin session or cron secret required", 401);
    }
  }

  try {
    const result = await reconcileMissingOnchainIds();
    return jsonOk(result);
  } catch (e) {
    return jsonError(`reconcile on-chain ids failed: ${(e as Error).message}`, 500);
  }
}

// Vercel Cron (and most schedulers) issue GET.
export { POST as GET };
