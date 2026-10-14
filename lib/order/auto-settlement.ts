import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { releaseOrderOnChain } from "@/lib/contracts/escrow-client";
import { createMmAuditLog } from "@/lib/mm";
import { ONCHAIN_FUNDS_ENABLED } from "@/lib/wallet/onchain-funding";
import { resolveSettlementRail } from "./settlement-rail";
import { recordLifecycleEvent } from "./patterns";

/**
 * .E — seller auto-settlement decision logic + the 42h auto-release pass.
 *
 * Owner requirement (translated): "money goes STRAIGHT into the seller's wallet
 * once the status is DONE, and is returned to the buyer automatically on
 * disputed/refund — WITHOUT a manual claim."
 *
 * The pure functions here pin the decision rules (TDD in
 * __tests__/lib/auto-settlement.test.ts):
 *   - shouldAutoRelease        — overdue SENT → must release (42h window).
 *   - isSettlementTerminal     — idempotency: never re-relay a settled row.
 *   - settlementActionForDisputeResolution — decision → relay action (no
 *     manual payout step).
 *   - disputeFinalStatus       — decision → DB landing status.
 *
 * `runAutoReleaseOnce()` is the orchestrated pass the cron calls: flips every
 * overdue SENT order to DONE via the atomic RPC and immediately relays
 * `releaseOrder` on-chain (the contract pays the seller `amount − 2%` directly —
 * `SELLER_FEE_BPS = 200`; the 2% buyer fee was taken at creation).
 */

/** Buyer inspection window after the seller sends credentials. */
export const AUTO_RELEASE_WINDOW_HOURS = 42;

const PLATFORM_WALLET_ID = process.env.PLATFORM_CIRCLE_WALLET_ID ?? "";

// ---------------------------------------------------------------------------
// Pure decision logic (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Defensive parse of an ISO deadline string → epoch ms. null/empty → null
 * ("no deadline"); garbage THROWS so a corrupt deadline can never be silently
 * treated as overdue (or as never-due).
 */
export function parseReleaseDeadline(deadline: string | null | undefined): number | null {
  if (deadline === null || deadline === undefined || deadline === "") return null;
  const t = new Date(deadline).getTime();
  if (Number.isNaN(t)) throw new Error(`invalid release deadline: ${deadline}`);
  return t;
}

export interface AutoReleaseCandidate {
  status: string;
  releaseDeadline: string | null;
}

/**
 * True when an order is eligible for the 42h auto-release: status SENT and
 * the release deadline has STRICTLY passed. Disputes null the deadline (timer
 * paused), which naturally disables auto-release here. Pure — no I/O.
 */
export function shouldAutoRelease(order: AutoReleaseCandidate, now: Date): boolean {
  if (order.status !== "SENT") return false;
  const deadlineMs = parseReleaseDeadline(order.releaseDeadline);
  if (deadlineMs === null) return false;
  return now.getTime() > deadlineMs;
}

/** On-chain statuses that mean the contract already settled this row. */
const TERMINAL_ONCHAIN_STATUSES = new Set(["RELEASED", "REFUNDED"]);

export interface SettlementRow {
  status: string;
  onChainStatus: string | null;
  /** Contract order/deal id stored on the row (null when never created). */
  onChainOrderId?: string | null;
}

/**
 * Idempotency guard: true when the row is already settled on-chain (or has no
 * on-chain entity to relay). Callers must SKIP terminal rows — never
 * double-relay money. Pure — no I/O.
 */
export function isSettlementTerminal(row: SettlementRow): boolean {
  if (TERMINAL_ONCHAIN_STATUSES.has(row.onChainStatus ?? "")) return true;
  // No contract entity was ever created for this row → nothing to relay.
  if (row.onChainOrderId === null || row.onChainOrderId === undefined || row.onChainOrderId === "") return true;
  return false;
}

export type DisputeDecision = "refund" | "release";
export type SettlementAction = "refund" | "release";

/**
 * Map an admin dispute decision to the on-chain settlement action. The relay
 * happens automatically inside resolveDispute — there is no separate manual
 * payout step. Pure — no I/O.
 */
export function settlementActionForDisputeResolution(decision: DisputeDecision): SettlementAction {
  if (decision === "refund" || decision === "release") return decision;
  throw new Error(`invalid dispute decision: ${String(decision)}`);
}

/** DB status a resolved dispute lands on. */
export function disputeFinalStatus(decision: DisputeDecision): "CANCELLED" | "DONE" {
  settlementActionForDisputeResolution(decision); // validate
  return decision === "refund" ? "CANCELLED" : "DONE";
}

// ---------------------------------------------------------------------------
// Orchestration — 42h auto-release pass (cron-driven)
// ---------------------------------------------------------------------------

export interface AutoReleaseResult {
  /** Orders flipped SENT→DONE by the atomic RPC this pass. */
  flipped: number;
  /** releaseOrder relays successfully submitted (mock or real). */
  released: number;
  /** Relays that threw (tracked release_failed; reconcile cron retries). */
  failed: number;
}

/** Parse a DB amount column to bigint defensively (null/garbage → 0n). */
function parseAmountOrZero(amount: string | number | null | undefined): bigint {
  if (amount === null || amount === undefined) return 0n;
  try {
    return BigInt(amount.toString());
  } catch {
    return 0n;
  }
}

/**
 * One auto-release pass. Steps per overdue SENT order:
 *   1. Atomic RPC flips SENT→DONE (ledger-credit variant in custodial mode;
 *      no-credit variant when ONCHAIN_WALLET_FUNDS=1 — the relay below IS the
 *      payout there). The RPC's `release_deadline < now()` clause is the same
 *      rule as shouldAutoRelease (42h window set by sendOrder).
 *   2. RELEASED lifecycle row (best-effort, never fails the payout).
 *   3. Relay releaseOrder on-chain (seller paid `amount − 2%` directly). Failure is
 *      tracked in on_chain_* columns so the reconcile cron retries — no human
 *      ever has to claim or re-trigger.
 *
 * Idempotent: the RPC only touches SENT rows; terminal on-chain rows are
 * skipped by isSettlementTerminal.
 */
export async function runAutoReleaseOnce(): Promise<AutoReleaseResult> {
  const admin = supabaseAdminClient();

  // B4 ledger-credit gate (same rationale as confirmOrder in transitions.ts):
  // in non-custodial mode the on-chain releaseOrder IS the seller payout, so
  // the no-credit variant avoids double-booking. Custodial mode unchanged.
  const { data: expired, error } = await admin.rpc(
    ONCHAIN_FUNDS_ENABLED ? "auto_release_expired_orders_noncustodial" : "auto_release_expired_orders",
  );
  if (error) {
    console.error("auto_release_expired_orders failed:", error.message);
    return { flipped: 0, released: 0, failed: 0 };
  }
  if (!expired?.length) return { flipped: 0, released: 0, failed: 0 };

  let released = 0;
  let failed = 0;
  for (const order of expired as Record<string, unknown>[]) {
    const orderId = order.id as string;
    const onChainId = (order.on_chain_order_id as string | null) ?? null;

    // (c) RELEASED lifecycle row for the auto-release payout. Best-effort.
    await recordLifecycleEvent(
      admin as unknown as Parameters<typeof recordLifecycleEvent>[0],
      {
        orderId,
        operation: "RELEASED",
        txHash: null,
        amountMicro: parseAmountOrZero(order.amount as string | null),
        note: "auto-release-42h",
      },
      { triggeredBy: "system" },
    );

    // relay only when the ORDER's rail is "on-chain".

    // The batch RPC above is chosen by the env flag, but the relay used to fire
    // on `isContractReady()` + a non-null id alone. With the contract always
    // deployed, an order created on-chain and auto-released after the flag was
    // turned OFF would be credited in the ledger AND paid on-chain — a double
    // payout. Deriving the rail from the row makes the two decisions agree.
    const rail = resolveSettlementRail({
      onChainOrderId: onChainId,
      onchainFundsEnabled: ONCHAIN_FUNDS_ENABLED,
    });

    // Idempotency guard: no contract entity / already settled / not an on-chain
    // order → nothing to relay.
    if (
      rail !== "on-chain" ||
      !PLATFORM_WALLET_ID ||
      !onChainId ||
      isSettlementTerminal({
        status: "DONE",
        onChainStatus: (order.on_chain_status as string | null) ?? null,
        onChainOrderId: onChainId,
      })
    ) continue;

    try {
      const result = await releaseOrderOnChain(onChainId, PLATFORM_WALLET_ID);
      // Optimistic marker; indexer sets terminal RELEASED on OrderReleased event.
      await admin.from("orders").update({
        on_chain_status: "release_pending",
        on_chain_circle_tx_id: result?.id ?? null,
        on_chain_last_attempt_at: new Date().toISOString(),
      }).eq("id", orderId);
      await createMmAuditLog({
        mmUserId: null,
        mmWalletId: PLATFORM_WALLET_ID,
        actorType: "auto_release",
        action: "RELEASE_ORDER",
        refId: orderId,
        circleTxId: result?.id,
        detail: { reason: "auto-release-42h", onChainOrderId: onChainId },
      });
      released++;
    } catch (e) {
      // Track failure in DB columns so the reconcile cron can retry.
      const errMsg = (e as Error).message;
      console.error("auto-release failed for order:", orderId, e);
      await admin.from("orders").update({
        on_chain_status: "release_failed",
        on_chain_error: errMsg,
        on_chain_retry_count: 0,
        on_chain_last_attempt_at: new Date().toISOString(),
      }).eq("id", orderId);
      await createMmAuditLog({
        mmUserId: null,
        mmWalletId: PLATFORM_WALLET_ID,
        actorType: "auto_release",
        action: "RELEASE_ORDER",
        refId: orderId,
        detail: { type: "on-chain-release-failed", error: errMsg, onChainOrderId: onChainId, reason: "auto-release-42h" },
      }).catch(() => {});
      failed++;
    }
  }
  return { flipped: (expired as unknown[]).length, released, failed };
}
