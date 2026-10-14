import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { logger } from "@/lib/logger";
import {
  resolveOrderIdFromCircleTx,
  resolveDealIdFromCircleTx,
} from "@/lib/contracts/resolver";

/**
 * finish what checkout confirm could not.
 *
 * THE HOLE THIS CLOSES: `confirmCheckoutOrder` (and `confirmWlDeal`) relay
 * `createOrderFor` / `createEscrowDealFor` through Circle, then wait up to ~60s
 * for the contract id to appear in the mined receipt. If that wait times out,
 * the row keeps a NULL `on_chain_order_id` / `on_chain_deal_id` while the funds
 * ARE in escrow. Nothing ever retried:
 *   - the indexer correlates by contract id only, so it cannot see the row;
 *   - `reconcileFailedOnChainReleases` filters `.not("on_chain_deal_id","is",null)`,
 *     so id-less deals are invisible to it;
 *   - the stuck-draft sweep used to CANCELL + restock such orders, stranding the
 *     buyer's USDC with no id left to refund against.
 *
 * This job takes the Circle tx id we now persist (`on_chain_circle_tx_id`), reads
 * the creation event out of the mined receipt, and writes the contract id back.
 * Once the id is set, the normal indexer/reconciler take over.
 *
 * Idempotent and safe to run repeatedly: it only touches rows whose id is still
 * NULL and which actually have a Circle tx id, and each pass is bounded.
 */

const MAX_PER_RUN = 25;
const RESOLVE_TIMEOUT_MS = 20_000;

export interface OnchainIdReconcileResult {
  ran: boolean;
  ordersResolved: number;
  dealsResolved: number;
  stillPending: number;
  reason?: string;
}

/** Order statuses where a missing contract id means "we may be out of sync". */
const ORDER_STATUSES = ["PENDING", "PROCESS", "SENT", "DONE", "DISPUTED"] as const;
/** Deal statuses where a missing contract id means the same. */
const DEAL_STATUSES = ["WAITING", "ESCROW", "COMPLETED", "DISPUTED"] as const;

/**
 * On-chain states that are already settled — the contract id is historical by
 * this point, not actionable.
 *
 * Without this the scan keeps picking up orders that finished successfully
 * (status DONE, on_chain_status RELEASED) but whose contract id was never
 * recorded, retries the resolve, fails, and logs a warning — every single run,
 * forever. `stillPending` then never reaches 0, so a genuinely stuck order is
 * indistinguishable from settled noise. The metric has to be able to go quiet
 * for it to mean anything.
 */
const SETTLED_ONCHAIN_STATES = ["RELEASED", "REFUNDED"] as const;

/**
 * Record that escrow creation can never succeed for this order and restock.
 *
 * Only safe because the Circle tx is TERMINALLY failed — no USDC ever moved,
 * so there is nothing to refund. The stock pop is undone (instant orders) so
 * the seller's credentials are not held hostage by a dead order.
 */
async function markOrderCreateFailed(
  admin: ReturnType<typeof supabaseAdminClient>,
  orderId: string,
  reason: string,
): Promise<void> {
  const { error: rpcErr } = await admin.rpc("restock_instant_order", {
    p_order_id: orderId,
    p_target_status: "CANCELLED",
  });
  if (rpcErr) {
    // Manual orders have no stock to restock — fall back to a plain status flip.
    await admin
      .from("orders")
      .update({
        status: "CANCELLED",
        cancel_reason: "escrow creation failed on-chain — no funds were moved",
      })
      .eq("id", orderId);
  }
  await admin
    .from("orders")
    .update({ on_chain_status: "create_failed", on_chain_error: reason.slice(0, 500) })
    .eq("id", orderId);
  logger.warn({ orderId }, "onchain-ids: escrow creation terminally failed — order cancelled");
}

export async function reconcileMissingOnchainIds(): Promise<OnchainIdReconcileResult> {
  const admin = supabaseAdminClient();

  if (!process.env.PLATFORM_CIRCLE_WALLET_ID) {
    return { ran: false, ordersResolved: 0, dealsResolved: 0, stillPending: 0, reason: "PLATFORM_CIRCLE_WALLET_ID not set" };
  }

  let ordersResolved = 0;
  let dealsResolved = 0;
  let stillPending = 0;

  // ---- orders ----
  const { data: orders, error: oErr } = await admin
    .from("orders")
    .select("id, on_chain_circle_tx_id, created_at")
    .is("on_chain_order_id", null)
    .not("on_chain_circle_tx_id", "is", null)
    .in("status", ORDER_STATUSES as unknown as string[])
    // Skip orders that already settled on-chain — nothing to reconcile.
    .not("on_chain_status", "in", `(${SETTLED_ONCHAIN_STATES.join(",")})`)
    .order("created_at", { ascending: true })
    .limit(MAX_PER_RUN);

  if (oErr) {
    logger.error({ err: oErr.message }, "onchain-ids: order scan failed");
  } else {
    for (const row of orders ?? []) {
      const circleTxId = row.on_chain_circle_tx_id as string;
      try {
        const { orderId, txHash } = await resolveOrderIdFromCircleTx(circleTxId, {
          timeoutMs: RESOLVE_TIMEOUT_MS,
        });
        if (!orderId) {
          stillPending++;
          logger.warn({ orderId: row.id, circleTxId }, "onchain-ids: order id still unresolved");
          continue;
        }
        const { error } = await admin
          .from("orders")
          .update({
            on_chain_order_id: orderId,
            ...(txHash ? { on_chain_tx_hash: txHash } : {}),
            on_chain_status: "CREATED",
            on_chain_error: null,
          })
          .eq("id", row.id)
          .is("on_chain_order_id", null); // never clobber a concurrent write
        if (error) {
          logger.error({ orderId: row.id, err: error.message }, "onchain-ids: order update failed");
          continue;
        }
        ordersResolved++;
        logger.info({ orderId: row.id, onChainOrderId: orderId }, "onchain-ids: order id resolved");
      } catch (e) {
        const msg = (e as Error).message || "";
        // A Circle tx that FAILED/never mined will never yield a contract id.
        // Marking those orders up-front stops this job retrying them every run
        // forever (they filled the log and made `stillPending` meaningless).
        if (/terminal-failed/i.test(msg)) {
          await markOrderCreateFailed(admin, row.id, msg);
        }
        stillPending++;
        logger.error({ orderId: row.id, err: msg }, "onchain-ids: order resolve threw");
      }
    }
  }

  // ---- WL deals ----
  const { data: deals, error: dErr } = await admin
    .from("wl_deals")
    .select("id, on_chain_circle_tx_id, created_at")
    .is("on_chain_deal_id", null)
    .not("on_chain_circle_tx_id", "is", null)
    .in("status", DEAL_STATUSES as unknown as string[])
    // Same reasoning as the order scan above.
    .not("on_chain_status", "in", `(${SETTLED_ONCHAIN_STATES.join(",")})`)
    .order("created_at", { ascending: true })
    .limit(MAX_PER_RUN);

  if (dErr) {
    logger.error({ err: dErr.message }, "onchain-ids: deal scan failed");
  } else {
    for (const row of deals ?? []) {
      const circleTxId = row.on_chain_circle_tx_id as string;
      try {
        const { dealId, txHash } = await resolveDealIdFromCircleTx(circleTxId, {
          timeoutMs: RESOLVE_TIMEOUT_MS,
        });
        if (!dealId) {
          stillPending++;
          logger.warn({ dealId: row.id, circleTxId }, "onchain-ids: deal id still unresolved");
          continue;
        }
        const { error } = await admin
          .from("wl_deals")
          .update({
            on_chain_deal_id: dealId,
            ...(txHash ? { on_chain_tx_hash: txHash } : {}),
            on_chain_status: "CREATED",
            on_chain_error: null,
          })
          .eq("id", row.id)
          .is("on_chain_deal_id", null);
        if (error) {
          logger.error({ dealId: row.id, err: error.message }, "onchain-ids: deal update failed");
          continue;
        }
        dealsResolved++;
        logger.info({ dealId: row.id, onChainDealId: dealId }, "onchain-ids: deal id resolved");
      } catch (e) {
        stillPending++;
        logger.error({ dealId: row.id, err: (e as Error).message }, "onchain-ids: deal resolve threw");
      }
    }
  }

  return { ran: true, ordersResolved, dealsResolved, stillPending };
}
