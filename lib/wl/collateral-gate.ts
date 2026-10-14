/**
 * A2 — collateral gate.
 *
 * WHY THIS EXISTS
 * ---------------
 * `MarketEscrow.createEscrowDeal` creates AND funds the on-chain deal in a single
 * call: the buyer's USDC leaves their wallet at the same moment the deal comes
 * into existence. The seller's `depositEscrowCollateral` therefore ALWAYS runs
 * afterwards — there is no on-chain deal to attach collateral to before that.
 *
 * That ordering cannot be reversed without a contract change (a two-phase
 * "seller creates an unfunded shell → seller deposits → buyer funds" flow), so
 * the practical protection is this gate: the app refuses to record a deal as
 * protected until the collateral is genuinely locked, and it reads the figure
 * from the CHAIN rather than trusting whatever the client submitted.
 *
 * Net effect: the DB can never claim "buyer funds + collateral locked" while the
 * collateral is missing. The buyer keeps a truthful picture of their exposure,
 * and a seller cannot skip the deposit and still get a protected deal.
 */

export interface CollateralGateInput {
  /** Whether this deal is required to carry seller collateral at all. */
  needsCollateral: boolean;
  /** The amount agreed between buyer and seller, in micro-USDC. */
  agreedMicro: bigint;
  /** The amount actually locked on-chain, in micro-USDC; null if the deal is missing. */
  onChainCollateral: bigint | null;
}

export type CollateralGateResult =
  | { ok: true; enforced: boolean; onChainCollateral: bigint | null }
  | { ok: false; reason: string };

/**
 * Decide whether a deal may advance to a protected state.
 *
 * Pure — no DB, no RPC — so every branch is unit-testable. The caller supplies
 * the on-chain reading; this function only judges it.
 */
export function evaluateCollateralGate(input: CollateralGateInput): CollateralGateResult {
  const { needsCollateral, agreedMicro, onChainCollateral } = input;

  // A deal that never required collateral is not gated. Note we still report
  // whatever collateral exists on-chain, because a seller may voluntarily add
  // some later (collateral only ever grows).
  if (!needsCollateral) {
    return { ok: true, enforced: false, onChainCollateral };
  }

  if (onChainCollateral === null) {
    return { ok: false, reason: "collateral gate: deal not found on-chain" };
  }

  if (onChainCollateral < agreedMicro) {
    return {
      ok: false,
      reason:
        `collateral gate: seller collateral on-chain is ${onChainCollateral} micro but ` +
        `${agreedMicro} micro was agreed — deposit the collateral before proceeding`,
    };
  }

  return { ok: true, enforced: true, onChainCollateral };
}
