/**
 * Fee model (2% + 2% on marketplace, 2% buyer-only on WL).
 *
 * MARKETPLACE (regular orders):
 *   - Buyer pays itemAmount + 2% (FEE_BPS), collected at creation into
 *     pendingFees and NON-REFUNDABLE (kept on release AND on refund).
 *   - Seller receives itemAmount - 2% (SELLER_FEE_BPS) at release, i.e. 98%.
 *   - Platform take = buyer fee + seller fee = 4% of the item amount.
 *
 * WL / ESCROW (rekber deals) — deliberately DIFFERENT:
 *   - Buyer pays price + 2%; seller receives 100% of `price`.
 *   - No seller-side fee. Platform take = 2%.
 *
 * Collateral (WL only): returned in full on both release and refund.
 *
 * Contract: MarketEscrow.sol
 *   computeFee(amount)       = amount * FEE_BPS / 10000        (buyer)
 *   computeSellerFee(amount) = amount * SELLER_FEE_BPS / 10000 (marketplace seller)
 *
 * All amounts in micro-USDC bigint (6 decimals).
 */

import { percentBps } from "./money";

/** Buyer-side platform fee in basis points (2% = 200 bps). Both flows. */
export const PLATFORM_FEE_BPS = 200;

/**
 * Seller-side platform fee in basis points (2% = 200 bps).
 * MARKETPLACE ORDERS ONLY — WL escrow deals charge no seller fee.
 */
export const MARKET_SELLER_FEE_BPS = 200;

/**
 * Buyer fee for a given amount. Mirrors the contract's `computeFee(amount)`.
 */
export function computeFee(amount: bigint): bigint {
  return percentBps(amount, PLATFORM_FEE_BPS);
}

/**
 * Seller fee deducted from the payout on a marketplace release.
 * Mirrors the contract's `computeSellerFee(amount)`.
 */
export function computeSellerFee(amount: bigint): bigint {
  return percentBps(amount, MARKET_SELLER_FEE_BPS);
}

/**
 * What a seller actually receives per unit after the platform fee.
 * Used by the listing form to show "you receive $9.80/item" as the seller types.
 */
export function computeSellerNet(unitPrice: bigint): bigint {
  return unitPrice - computeSellerFee(unitPrice);
}

/**
 * @deprecated Since v4 (2026-08-11). Use computeFee() instead.
 * Retained for backward-compat with any legacy callers.
 */
export const BUYER_ADMIN_FEE_BPS = PLATFORM_FEE_BPS;

/**
 * @deprecated Since v4. The $4 base fee is removed — the 2%+2% model replaces it.
 * Retained for backward-compat; always returns 0n.
 */
export function baseFeeEscrowMicro(): bigint {
  return 0n;
}

/**
 * @deprecated Since Phase 3.1 (non-custodial migration). Circle fee + gas are
 * no longer charged to the buyer. Retained for backward-compat; always 0n.
 */
export function estimateCircleFeeMicro(_itemAmount: bigint): bigint {
  return 0n;
}

/**
 * @deprecated Since Phase 3.1. Gas is paid by the buyer's own wallet on Arc
 * (approve) or the DCW relayer (createOrderFor). Not charged via this fee model.
 */
export const ESTIMATED_GAS_MICRO = 0n;

export function estimateGasMicro(_delivery?: "instant" | "manual"): bigint {
  return 0n;
}

/** Marketplace checkout math (buyer pays itemAmount + 2%). */
export interface MarketplaceCheckout {
  itemAmount: bigint; // unit price * qty
  fee: bigint; // 2% of itemAmount, beban buyer (non-refundable)
  /** @deprecated alias for `fee` (backward compat with old callers). */
  buyerAdminFee: bigint;
  /** @deprecated always 0n since Phase 3.1. */
  circleFee: bigint;
  /** @deprecated always 0n since Phase 3.1. */
  gasFee: bigint;
  buyerPaysTotal: bigint; // == itemAmount + fee
}

export function computeMarketplaceCheckout(
  unitPrice: bigint,
  qty: number,
  _delivery?: "instant" | "manual"
): MarketplaceCheckout {
  if (qty < 1) throw new Error(`qty must be >= 1, got ${qty}`);
  const itemAmount = unitPrice * BigInt(qty);
  const fee = computeFee(itemAmount);
  return {
    itemAmount,
    fee,
    buyerAdminFee: fee, // backward-compat alias
    circleFee: 0n,
    gasFee: 0n,
    buyerPaysTotal: itemAmount + fee,
  };
}

/**
 * Marketplace payout at release. The seller receives itemAmount MINUS the 2%
 * seller fee (= 98%); the seller fee joins the buyer fee in pendingFees, so the
 * platform's total take on the order is 4% of the item amount.
 *
 * The contract performs this deduction at release; this helper mirrors it for
 * display and for the API's revenue figures.
 */
export function computeMarketplacePayout(itemAmount: bigint): {
  sellerPayout: bigint;
  sellerFee: bigint;
  /** Total platform take on this order: buyer fee + seller fee. */
  platformFee: bigint;
} {
  const buyerFee = computeFee(itemAmount);
  const sellerFee = computeSellerFee(itemAmount);
  return {
    sellerPayout: itemAmount - sellerFee,
    sellerFee,
    platformFee: buyerFee + sellerFee,
  };
}

/** WL / Escrow checkout (buyer pays, seller receives at release). */
export interface EscrowCheckout {
  itemAmount: bigint; // unit * qty (the "price")
  fee: bigint; // 2% of price, beban buyer (non-refundable)
  /** @deprecated always 0n. The $4 base fee is removed in v4. */
  baseFee: bigint;
  /** @deprecated always 0n since Phase 3.1. */
  circleFee: bigint;
  /** @deprecated always 0n since Phase 3.1. */
  gasFee: bigint;
  buyerPaysTotal: bigint; // == itemAmount + fee
}

export function computeEscrowCheckout(
  unitPrice: bigint,
  qty: number
): EscrowCheckout {
  if (qty < 1) throw new Error(`qty must be >= 1, got ${qty}`);
  const itemAmount = unitPrice * BigInt(qty);
  const fee = computeFee(itemAmount);
  return {
    itemAmount,
    fee,
    baseFee: 0n, // deprecated, always 0
    circleFee: 0n,
    gasFee: 0n,
    buyerPaysTotal: itemAmount + fee,
  };
}

/**
 * Escrow release payout: seller receives 100% of `price` (the WL flow charges
 * the buyer only — there is NO seller-side fee here, unlike marketplace orders).
 * Fee already collected at creation. Collateral returned in full.
 */
export function computeEscrowPayout(itemAmount: bigint): {
  sellerPayout: bigint;
  platformFee: bigint; // buyer fee only, already collected; returned for display
} {
  return {
    sellerPayout: itemAmount,
    platformFee: computeFee(itemAmount),
  };
}
