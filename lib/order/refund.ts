import type { CurrentUser } from "@/lib/auth-ucw";
import { notifyUser } from "@/lib/notif";
import { orderRefundedTemplate } from "@/lib/notif/templates";
import { ONCHAIN_FUNDS_ENABLED } from "@/lib/wallet/onchain-funding";
import { resolveSettlementRail } from "./settlement-rail";
import { ARC_EXPLORER_TX_BASE } from "@/lib/arc";
import {
  ApiValidationError,
  bestEffortPersist,
  guardTransition,
  recordLifecycleEvent as recordLifecycleEventReal,
  type BuildLifecycleInput,
  type CheckoutStatus,
} from "./patterns";

/**
 * admin order refund, rebuilt on the REAL on-chain refund path.
 *
 * Replaces the previous fake-refund route (which returned a mock tx hash and
 * touched nonexistent columns, marking orders refunded WITHOUT moving funds).
 *
 * Real entrypoint: MarketEscrow.refundOrder(uint256 orderId) — `onlyOperator`,
 * returns `amount` (the item subtotal) to the buyer directly, and reverts if the
 * order is already released/refunded on chain. The buyer fee is NOT refunded
 * (non-refundable, already in pendingFees), and no seller fee is charged because
 * the seller is never paid on a refund. Relayed via Circle DCW
 * (`refundOrderOnChain` in lib/contracts/escrow-client.ts), the same helper
 * cancel/decline/dispute-resolve use.
 *
 * Funds-first invariant: the DB is NEVER updated to claim a refund before the
 * on-chain relay submission is accepted. Relay failure → 502, DB untouched.
 */

/**
 * Statuses an admin may force-refund. Exactly one: DISPUTED.
 *
 * Why only DISPUTED:
 *  - The orders.status DB CHECK (migration 0001, never widened) only allows
 *    PENDING/PROCESS/SENT/DONE/DISPUTED/CANCELLED/DECLINED. "REFUNDED" is NOT
 *    a writable status — the refund outcome status is CANCELLED (set by
 *    resolve_dispute_atomic / cancel_order_atomic), DECLINED (decline), with
 *    the REFUND recorded in lifecycle_events + on_chain_status.
 *  - DISPUTED is the only status where funds are still escrowed AND neither
 *    party can self-serve: buyer can't cancel (needs PENDING/PROCESS), seller
 *    can't decline, release only fires on DONE. Admin force-refund of DONE
 *    would double-refund (seller already paid out); CANCELLED/DECLINED were
 *    already refunded.
 */
export const REFUNDABLE_BY_ADMIN_STATUSES: readonly CheckoutStatus[] = ["DISPUTED"];

/** Final DB status after an admin refund (resolve_dispute_atomic refund branch). */
export const ADMIN_REFUND_FINAL_STATUS = "CANCELLED";

/** Columns the refund flow needs — the REAL orders schema only. */
export interface RefundableOrderRow {
  id: string;
  status: string;
  /** bigint micro-USDC as string (orders.amount). */
  amount: string | null;
  buyer_id: string;
  /** MarketEscrow order counter id captured at checkout (0014). */
  on_chain_order_id: string | null;
  /** bigint micro-USDC as string (orders.buyer_fee). */
  buyer_fee: string | null;
  /** On-chain tx hash captured at checkout. */
  on_chain_tx_hash: string | null;
}

/** Minimal Supabase-admin-client surface this module uses (injectable fakes in tests). */
export interface RefundAdmin {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        maybeSingle(): PromiseLike<{ data: RefundableOrderRow | null; error: { message: string } | null }>;
      };
    };
    update(patch: Record<string, unknown>): {
      eq(column: string, value: string): PromiseLike<{ error: { message: string } | null }>;
    };
    insert(
      row: Record<string, unknown> | import("./patterns").LifecycleEventInsert,
    ): PromiseLike<{ error: { message: string } | null }>;
  };
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{
    data: unknown;
    error: { message: string } | null;
  }>;
}

/** Injectable dependencies — tests fake these; the route wires the real ones. */
export interface RefundDeps {
  admin: RefundAdmin;
  /** Whether ESCROW_CONTRACT_ADDRESS + PLATFORM_CIRCLE_WALLET_ID + Circle SDK are configured. */
  isContractReady: () => boolean;
  /**
   * Relays MarketEscrow.refundOrder(uint256) via Circle DCW. Returns the
   * Circle tx submission ({ id }) or null when the contract is not ready.
   * Throws when the relay itself fails.
   */
  refundOrderOnChain: (
    onChainOrderId: string,
    walletId: string,
  ) => Promise<{ id: string; state?: string } | null>;
  /** Best-effort lifecycle write (lib/order/patterns.recordLifecycleEvent). */
  recordLifecycleEvent: (
    admin: RefundAdmin,
    input: BuildLifecycleInput,
    context?: Record<string, unknown>,
  ) => Promise<void>;
  logger: {
    info: (ctx: object, msg: string) => void;
    warn: (ctx: object, msg: string) => void;
    error: (ctx: object, msg: string) => void;
  };
  /** Circle DCW wallet id that pays gas + is the contract operator. */
  platformWalletId: string;
  /**
   * .A — non-custodial mode selector for the settlement RPC. Defaults to
   * ONCHAIN_FUNDS_ENABLED; injectable for tests. Non-custodial MUST use the
   * no-ledger-credit variant: the on-chain refund already returned the buyer's
   * money, so crediting wallets.usdc_balance too would double-book it.
   */
  nonCustodial?: boolean;
}

export interface ProcessRefundResult {
  /** Final orders.status after the atomic (CANCELLED — the REFUNDED-equivalent). */
  status: string;
  /** Circle transaction id for the refundOrder relay (null if relay returned none). */
  txId: string | null;
  onChainOrderId: string;
}

/** Parse orders.amount (bigint column → string) defensively. */
function parseAmountOrZero(amount: string | number | null | undefined): bigint {
  if (amount === null || amount === undefined) return 0n;
  try {
    return BigInt(amount.toString());
  } catch {
    return 0n;
  }
}

/**
 * Admin force-refund core. Ordering matters (funds-first):
 *
 *  1. Load order (404 if missing).
 *  2. Status guard — DISPUTED only (409 otherwise, incl. already-refunded).
 *  3. Escrow availability guard (503 contract-not-ready / 501 no on-chain id).
 *  4. Relay MarketEscrow.refundOrder via Circle DCW. Throw → 502, DB untouched.
 *  5. ONLY NOW run the SAME ledger transition dispute-resolve uses
 *     (resolve_dispute_atomic decision=refund → ledger refund + status CANCELLED).
 *  6. Mirror on_chain_status='refund_pending' + Circle tx id (best-effort;
 *     reconcile cron backstops).
 *  7. Write the REFUNDED lifecycle event (best-effort, per patterns).
 */
export async function processOrderRefund(
  deps: RefundDeps,
  input: { orderId: string; reason: string },
  actor: Pick<CurrentUser, "id" | "role">,
): Promise<ProcessRefundResult> {
  const { orderId, reason } = input;

  // 1. Load.
  const { data: order, error: loadErr } = await deps.admin
    .from("orders")
    .select("id, status, amount, buyer_id, on_chain_order_id, buyer_fee, on_chain_tx_hash")
    .eq("id", orderId)
    .maybeSingle();
  if (loadErr) throw new Error(loadErr.message);
  if (!order) {
    throw new ApiValidationError(`order ${orderId} not found`, "ORDER_NOT_FOUND", 404);
  }

  // 2. Status guard. DISPUTED only — wrong status (incl. CANCELLED/DECLINED
  // which were ALREADY refunded) → 409. This is also the idempotency gate: a
  // second call after the atomic flipped the status to CANCELLED is rejected
  // before any relay, so funds can never move twice.
  guardTransition(order.status, REFUNDABLE_BY_ADMIN_STATUSES, "refund");

  // 3. Escrow availability. Funds are on chain; without a working relay this
  // endpoint CANNOT honestly refund — fail loudly instead of faking it.
  if (!deps.isContractReady()) {
    throw new ApiValidationError(
      "escrow contract relay not configured (ESCROW_CONTRACT_ADDRESS / PLATFORM_CIRCLE_WALLET_ID / Circle SDK) — cannot move funds, refusing to update DB",
      "ESCROW_UNAVAILABLE",
      503,
    );
  }
  const onChainId = order.on_chain_order_id;
  if (!onChainId) {
    // No MarketEscrow order id was captured at checkout — the funds for this
    // order were never locked in the contract, so there is no on-chain refund
    // to relay. Do not invent one.
    throw new ApiValidationError(
      "order has no on_chain_order_id — no MarketEscrow order to refund on chain",
      "NO_ONCHAIN_REFUND_PATH",
      501,
    );
  }

  // 4. FUNDS FIRST — relay the refund. Any failure here must NOT touch the DB.
  let relay: { id: string; state?: string } | null;
  try {
    relay = await deps.refundOrderOnChain(onChainId, deps.platformWalletId);
  } catch (e) {
    deps.logger.error(
      { orderId, onChainId, err: (e as Error).message },
      "admin-refund: relay failed — DB left untouched",
    );
    throw new ApiValidationError(
      `on-chain refund relay failed: ${(e as Error).message}`,
      "REFUND_RELAY_FAILED",
      502,
    );
  }
  const txId = relay?.id ?? null;

  deps.logger.info(
    { orderId, onChainId, txId, triggeredBy: actor.id },
    "admin-refund: relay accepted, applying DB transition",
  );

  // 5. DB transition — dispute-resolve settlement RPC (status → CANCELLED;
  // the custodial variant also moves the ledger, the non-custodial one does
  // NOT — .A). Guarded by the DISPUTED check inside the RPC (FOR UPDATE
  // row lock), so a concurrent resolve cannot double-move anything.
  // the rail is unambiguous on this path: step 3 above already
  // REQUIRED a non-null `on_chain_order_id`, and the on-chain refund relay has
  // ALREADY been submitted. So the money is in MarketEscrow and the ledger must
  // NOT also move. Deriving this from `ONCHAIN_FUNDS_ENABLED` meant that with
  // the flag off (custodial) the code picked `resolve_dispute_atomic`, crediting
  // the buyer's ledger ON TOP of the on-chain refund — a double refund.
  const rail = resolveSettlementRail({
    onChainOrderId: onChainId,
    onchainFundsEnabled: ONCHAIN_FUNDS_ENABLED,
  });
  const nonCustodial = deps.nonCustodial ?? rail === "on-chain";
  const rpcName = nonCustodial ? "resolve_dispute_noncustodial" : "resolve_dispute_atomic";
  const { error: rpcErr } = await deps.admin.rpc(rpcName, {
    p_order_id: orderId,
    p_actor_id: actor.id,
    p_decision: "refund",
    p_reason: reason,
  });
  if (rpcErr) throw new Error(`${rpcName}: ${rpcErr.message}`);

  // 6. Mirror on-chain state (best-effort — reconcile cron retries; the ledger
  // already moved so a mirror failure must not fail the request).
  await bestEffortPersist(
    "admin-refund:update-onchain-refund-pending",
    async () => {
      const { error: upErr } = await deps.admin
        .from("orders")
        .update({
          on_chain_status: "refund_pending",
          on_chain_circle_tx_id: txId,
          on_chain_last_attempt_at: new Date().toISOString(),
        })
        .eq("id", orderId);
      if (upErr) throw new Error(upErr.message);
    },
    { logger: deps.logger, context: { orderId, onChainId } },
  );

  // 7. REFUNDED lifecycle row (best-effort per patterns — never fails a money
  // path). Written after the ledger transition, carrying the relay tx id.
  await deps.recordLifecycleEvent(
    deps.admin,
    {
      orderId,
      operation: "REFUNDED",
      txHash: txId,
      amountMicro: parseAmountOrZero(order.amount),
      note: `admin-refund: ${reason}`,
    },
    { triggeredBy: actor.id },
  );

  // the refund is relayed straight to the buyer's wallet; without a
  // notification the order just silently changed status. Best-effort.
  const refundAmountUsdc = (Number(parseAmountOrZero(order.amount)) / 1_000_000).toFixed(2);
  const feeUsdc = (Number(parseAmountOrZero(order.buyer_fee)) / 1_000_000).toFixed(2);

  const template = orderRefundedTemplate({
    orderId,
    itemName: "Order item",
    refundAmountUsdc,
    feeNotRefundedUsdc: feeUsdc,
    reason: reason || undefined,
    txHash: (order.on_chain_tx_hash as string) || null,
    explorerUrl: ARC_EXPLORER_TX_BASE,
    appUrl: process.env.NEXT_PUBLIC_APP_URL || "https://slimemarket.app",
  });

  await notifyUser(order.buyer_id as string, {
    icon: "undo-2",
    tone: "emerald",
    title: "Refund Sent",
    text: `Order ${orderId.slice(0, 8)} was refunded. ${refundAmountUsdc} USDC is on its way back to your wallet. The 2% service fee is not refundable.`,
    link: "orders",
    email: template,
  }).catch(() => {});

  return { status: ADMIN_REFUND_FINAL_STATUS, txId, onChainOrderId: onChainId };
}

/** The real lifecycle recorder, re-exported so the route wires one import. */
export const lifecycleRecorder = recordLifecycleEventReal;
