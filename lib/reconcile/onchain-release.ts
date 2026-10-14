import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { releaseOrderOnChain, refundOrderOnChain, releaseEscrowOnChain, refundEscrowOnChain } from "@/lib/contracts/escrow-client";
import { waitForCircleTxState } from "@/lib/wallet/circle-tx-status";
import { createMmAuditLog } from "@/lib/mm";
import { logger } from "@/lib/logger";

const PLATFORM_WALLET_ID = process.env.PLATFORM_CIRCLE_WALLET_ID ?? "";
const MAX_RETRIES = 5;

interface ReconcileResult {
  scanned: number;
  retried: number;
  confirmed: number;
  stillFailed: number;
}

/**
 * Reconciles on-chain release/refund calls that are stuck in pending or failed
 * state. For each order/wl_deal with `on_chain_status` in
 * {release_pending, refund_pending, release_failed, refund_failed} and under
 * the MAX_RETRIES cap:
 *
 *   1. If a Circle tx id is set and the status is *_pending, poll Circle first.
 *      - CONFIRMED/COMPLETE → counted as confirmed (indexer reconciles terminal state).
 *      - FAILED/CANCELLED/DENIED → fall through and retry the on-chain call.
 *      - Still pending or poll error → leave for the next cycle.
 *   2. Otherwise retry the on-chain call (release/refund via platform DCW) and
 *      bump on_chain_retry_count. On the final failed attempt, write a
 *      RECONCILE_DRIFT audit row so ops get paged.
 *
 * Idempotent: terminal states (RELEASED/REFUNDED set by the indexer) are
 * excluded from the scan set, so this is safe to run every 5 minutes.
 */
export async function reconcileFailedOnChainReleases(): Promise<ReconcileResult> {
  const admin = supabaseAdminClient();
  let scanned = 0, retried = 0, confirmed = 0, stillFailed = 0;

  // Scan orders with pending/failed on-chain release/refund
  const { data: orders } = await admin.from("orders")
    .select("id, status, on_chain_order_id, on_chain_status, on_chain_circle_tx_id, on_chain_retry_count")
    .in("on_chain_status", ["release_pending", "refund_pending", "release_failed", "refund_failed"])
    .lt("on_chain_retry_count", MAX_RETRIES)
    .not("on_chain_order_id", "is", null)
    .limit(20);

  for (const o of (orders ?? []) as Record<string, unknown>[]) {
    scanned++;
    const orderId = o.id as string;
    const onChainId = o.on_chain_order_id as string;
    const isRefund = (o.on_chain_status as string)?.startsWith("refund");
    const circleTxId = o.on_chain_circle_tx_id as string | null;
    const retryCount = (o.on_chain_retry_count as number) ?? 0;

    // If has a Circle tx id and status is *_pending, poll first
    if (circleTxId && (o.on_chain_status as string)?.endsWith("_pending")) {
      try {
        const state = await waitForCircleTxState(circleTxId, { timeoutMs: 10_000 });
        if (state === "CONFIRMED" || state === "COMPLETE") {
          confirmed++;
          continue; // Indexer will reconcile
        }
        if (state !== "FAILED" && state !== "CANCELLED" && state !== "DENIED") {
          continue; // Still pending, leave for next cycle
        }
        // Tx failed — fall through to retry
      } catch (e) {
        // Polling failed — leave for next cycle
        logger.warn({ circleTxId, err: (e as Error).message }, "onchain-release reconcile: poll failed");
        continue;
      }
    }

    // Retry the on-chain call
    try {
      const result = isRefund
        ? await refundOrderOnChain(onChainId, PLATFORM_WALLET_ID)
        : await releaseOrderOnChain(onChainId, PLATFORM_WALLET_ID);
      await admin.from("orders").update({
        on_chain_status: isRefund ? "refund_pending" : "release_pending",
        on_chain_circle_tx_id: result?.id ?? null,
        on_chain_retry_count: retryCount + 1,
        on_chain_last_attempt_at: new Date().toISOString(),
        on_chain_error: null,
      }).eq("id", orderId);
      retried++;
    } catch (e) {
      const errMsg = (e as Error).message;
      await admin.from("orders").update({
        on_chain_status: isRefund ? "refund_failed" : "release_failed",
        on_chain_error: errMsg,
        on_chain_retry_count: retryCount + 1,
        on_chain_last_attempt_at: new Date().toISOString(),
      }).eq("id", orderId);
      if (retryCount + 1 >= MAX_RETRIES) {
        await createMmAuditLog({
          mmUserId: null, mmWalletId: PLATFORM_WALLET_ID,
          actorType: "system",
          action: "RECONCILE_DRIFT", refId: orderId,
          detail: { type: "on-chain-release-max-retries", error: errMsg, onChainId, isRefund },
        }).catch(() => {});
      }
      stillFailed++;
    }
  }

  // Same for wl_deals
  const { data: deals } = await admin.from("wl_deals")
    .select("id, status, on_chain_deal_id, on_chain_status, on_chain_circle_tx_id, on_chain_retry_count")
    .in("on_chain_status", ["release_pending", "refund_pending", "release_failed", "refund_failed"])
    .lt("on_chain_retry_count", MAX_RETRIES)
    .not("on_chain_deal_id", "is", null)
    .limit(20);

  for (const d of (deals ?? []) as Record<string, unknown>[]) {
    scanned++;
    const dealId = d.id as string;
    const onChainId = d.on_chain_deal_id as string;
    const isRefund = (d.on_chain_status as string)?.startsWith("refund");
    const circleTxId = d.on_chain_circle_tx_id as string | null;
    const retryCount = (d.on_chain_retry_count as number) ?? 0;

    if (circleTxId && (d.on_chain_status as string)?.endsWith("_pending")) {
      try {
        const state = await waitForCircleTxState(circleTxId, { timeoutMs: 10_000 });
        if (state === "CONFIRMED" || state === "COMPLETE") { confirmed++; continue; }
        if (state !== "FAILED" && state !== "CANCELLED" && state !== "DENIED") continue;
      } catch (e) {
        logger.warn({ circleTxId, err: (e as Error).message }, "onchain-release reconcile: poll failed (wl_deal)");
        continue;
      }
    }

    try {
      const result = isRefund
        ? await refundEscrowOnChain(onChainId, PLATFORM_WALLET_ID)
        : await releaseEscrowOnChain(onChainId, PLATFORM_WALLET_ID);
      await admin.from("wl_deals").update({
        on_chain_status: isRefund ? "refund_pending" : "release_pending",
        on_chain_circle_tx_id: result?.id ?? null,
        on_chain_retry_count: retryCount + 1,
        on_chain_last_attempt_at: new Date().toISOString(),
        on_chain_error: null,
      }).eq("id", dealId);
      retried++;
    } catch (e) {
      const errMsg = (e as Error).message;
      await admin.from("wl_deals").update({
        on_chain_status: isRefund ? "refund_failed" : "release_failed",
        on_chain_error: errMsg,
        on_chain_retry_count: retryCount + 1,
        on_chain_last_attempt_at: new Date().toISOString(),
      }).eq("id", dealId);
      if (retryCount + 1 >= MAX_RETRIES) {
        await createMmAuditLog({
          mmUserId: null, mmWalletId: PLATFORM_WALLET_ID,
          actorType: "system",
          action: "RECONCILE_DRIFT", refId: dealId,
          detail: { type: "on-chain-release-max-retries", error: errMsg, onChainId, isRefund },
        }).catch(() => {});
      }
      stillFailed++;
    }
  }

  return { scanned, retried, confirmed, stillFailed };
}
