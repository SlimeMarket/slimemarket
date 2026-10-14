/**
 * which rail holds the buyer's money, and therefore how to settle.
 *
 * THE BUG THIS PREVENTS
 * ---------------------
 * Settlement used to be split across two INDEPENDENT conditions:
 *
 *   - the ledger credit (buyer→seller payout, refund, dispute outcome) keyed off
 *     the env flag `ONCHAIN_FUNDS_ENABLED`;
 *   - the on-chain relay (`releaseOrder` / `refundOrder`) keyed off
 *     `isContractReady()` plus a non-null `on_chain_order_id`.
 *
 * With the contract deployed (always true after launch), those two conditions
 * disagree whenever the flag changes between order CREATION and settlement:
 *
 *   - order created with the flag OFF (custodial, no on-chain id), then released
 *     with the flag ON  → NO ledger credit and NO relay → order marked DONE and
 *     the seller is paid NOTHING.
 *   - order created with the flag ON (on-chain id set), then released with the
 *     flag OFF → ledger credit AND an on-chain `releaseOrder` → the platform
 *     pays the seller TWICE.
 *
 * The rail is a property of the ORDER, not of the current environment. An order
 * that has a contract id was funded into MarketEscrow; one that does not was
 * funded through the platform ledger. Reading that from the row makes settlement
 * idempotent and immune to config changes.
 *
 * The third case is an ANOMALY that must not be settled at all: non-custodial
 * mode, yet the order never got a contract id. That happens when the relay
 * reached Circle but the contract id could not be read out of the receipt in
 * time (`paymentPending`). The buyer's USDC may already be in escrow under an id
 * we do not know yet. Crediting the ledger would mint money the platform does
 * not hold; relaying is impossible without the id. The only safe action is to
 * refuse and let `/api/admin/reconcile/onchain-ids` backfill the id, after which
 * the normal retry settles correctly.
 */

/** Settlement rail for a single order. */
export type SettlementRail = "on-chain" | "ledger" | "unresolved";

/**
 * True when the row carries a usable contract id.
 *
 * `"0"` IS a valid contract id (the first order) — only null / undefined / ""
 * mean "not on-chain". Mirrors `hasOnChainDeal` in lib/wl/transitions.ts.
 */
export function hasOnChainOrder(onChainOrderId: string | null | undefined): boolean {
  return typeof onChainOrderId === "string"
    ? onChainOrderId.trim().length > 0
    : onChainOrderId !== null && onChainOrderId !== undefined;
}

/**
 * Decide the settlement rail for an order. Pure — no I/O.
 *
 * @param onChainOrderId        `orders.on_chain_order_id` as stored.
 * @param onchainFundsEnabled   `ONCHAIN_FUNDS_ENABLED` (the env flag).
 */
export function resolveSettlementRail(params: {
  onChainOrderId: string | null | undefined;
  onchainFundsEnabled: boolean;
}): SettlementRail {
  if (hasOnChainOrder(params.onChainOrderId)) return "on-chain";
  // No contract id. In custodial mode the platform ledger holds the money; in
  // non-custodial mode this is the unresolved-id anomaly described above.
  return params.onchainFundsEnabled ? "unresolved" : "ledger";
}

/** Typed 409 so routes surface it instead of a generic 500. */
export function unresolvedRailError(): Error & { httpStatus: number; code: string } {
  const e = new Error(
    "order is not settled on-chain yet — its escrow contract id has not been resolved. " +
      "No funds have been released. Retry once the reconciliation job backfills the id.",
  ) as Error & { httpStatus: number; code: string };
  e.httpStatus = 409;
  e.code = "ONCHAIN_ID_UNRESOLVED";
  return e;
}
