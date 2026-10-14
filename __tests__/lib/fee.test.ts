/**
 * Characterization tests for lib/fee.ts (2% + 2% marketplace model).
 *
 * MARKETPLACE:
 *  - Buyer pays item + 2% (FEE_BPS), non-refundable, collected at creation.
 *  - Seller receives item - 2% (SELLER_FEE_BPS) at release, i.e. 98%.
 *  - Platform take = buyer fee + seller fee = 4%.
 * WL / ESCROW:
 *  - Buyer pays price + 2%; seller receives 100% of price (no seller fee).
 *
 * All amounts are micro-USDC bigint (6 decimals). These tests pin exact bigint
 * math, including integer truncation on odd amounts.
 * If one fails, that is a real money bug — report it; do not edit lib/fee.ts.
 */
import { describe, it, expect } from "vitest";
import {
  PLATFORM_FEE_BPS,
  MARKET_SELLER_FEE_BPS,
  BUYER_ADMIN_FEE_BPS,
  computeFee,
  computeSellerFee,
  computeSellerNet,
  baseFeeEscrowMicro,
  ESTIMATED_GAS_MICRO,
  estimateCircleFeeMicro,
  estimateGasMicro,
  computeMarketplaceCheckout,
  computeMarketplacePayout,
  computeEscrowCheckout,
  computeEscrowPayout,
} from "@/lib/fee";

describe("fee constants ", () => {
  it("buyer fee is 2% (200 bps), non-refundable", () => {
    expect(PLATFORM_FEE_BPS).toBe(200);
  });

  it("seller fee is 2% (200 bps) — marketplace only", () => {
    expect(MARKET_SELLER_FEE_BPS).toBe(200);
  });

  it("buyer admin fee alias matches platform fee (backward compat)", () => {
    expect(BUYER_ADMIN_FEE_BPS).toBe(200);
  });

  it("baseFeeEscrowMicro() returns 0n (v4 removed the $4 base fee)", () => {
    expect(baseFeeEscrowMicro()).toBe(0n);
  });
});

describe("computeFee — 2% mirror of contract computeFee()", () => {
  it("10_000_000n → fee 200_000n", () => {
    expect(computeFee(10_000_000n)).toBe(200_000n);
  });

  it("truncates toward zero on odd amounts (amount*300/10000)", () => {
    // 999_999 * 300 / 10_000 = 29_999.97 → 19_999n (floor)
    expect(computeFee(999_999n)).toBe(19_999n);
  });

  it("sub-cent amounts: fee truncates to 0n", () => {
    // 32 * 300 / 10_000 = 0.96 → 0n
    expect(computeFee(32n)).toBe(0n);
  });

  it("zero amount → zero fee", () => {
    expect(computeFee(0n)).toBe(0n);
  });

  it("large values stay exact bigint (no float)", () => {
    const amount = 12_345_678_901_123_456n;
    expect(computeFee(amount)).toBe((amount * 200n) / 10_000n);
  });
});

describe("computeMarketplacePayout — seller nets 98% (2%+2% model)", () => {
  it("10_000_000n → sellerPayout 9_800_000n, sellerFee 200_000n, platformFee 400_000n", () => {
    const { sellerPayout, sellerFee, platformFee } = computeMarketplacePayout(10_000_000n);
    expect(sellerPayout).toBe(9_800_000n); // 98% of the item
    expect(sellerFee).toBe(200_000n);
    expect(platformFee).toBe(400_000n); // buyer 2% + seller 2%
  });

  it("seller payout is always amount minus the 2% seller fee", () => {
    for (const amount of [1n, 49n, 10_000_000n, 999_999_999n]) {
      const { sellerPayout, sellerFee } = computeMarketplacePayout(amount);
      expect(sellerPayout).toBe(amount - sellerFee);
      expect(sellerFee).toBe((amount * 200n) / 10_000n);
    }
  });

  it("platform take equals buyer fee + seller fee", () => {
    const amount = 12_345_678n;
    const { platformFee } = computeMarketplacePayout(amount);
    expect(platformFee).toBe(computeFee(amount) + computeSellerFee(amount));
  });

  it("zero amount → all zero", () => {
    expect(computeMarketplacePayout(0n)).toEqual({
      sellerPayout: 0n,
      sellerFee: 0n,
      platformFee: 0n,
    });
  });
});

describe("computeSellerFee / computeSellerNet — listing-time disclosure", () => {
  it("2% of the unit price", () => {
    expect(computeSellerFee(10_000_000n)).toBe(200_000n);
  });

  it("seller net on a $10 listing is $9.80", () => {
    expect(computeSellerNet(10_000_000n)).toBe(9_800_000n);
  });

  it("net + fee always reconstruct the original amount", () => {
    for (const amount of [1n, 999n, 10_000_000n, 999_999_999n]) {
      expect(computeSellerNet(amount) + computeSellerFee(amount)).toBe(amount);
    }
  });
});

describe("computeMarketplaceCheckout — buyer pays item + 2% fee", () => {
  it("exact math: 10_000_000n unit, qty 1", () => {
    const r = computeMarketplaceCheckout(10_000_000n, 1);
    expect(r.itemAmount).toBe(10_000_000n);
    expect(r.fee).toBe(200_000n); // 2% of itemAmount
    expect(r.buyerAdminFee).toBe(200_000n); // backward-compat alias
    expect(r.buyerPaysTotal).toBe(10_200_000n); // itemAmount + fee
  });

  it("qty multiplies itemAmount; fee computed on the total", () => {
    const r = computeMarketplaceCheckout(3_333_333n, 3);
    expect(r.itemAmount).toBe(9_999_999n);
    // 9_999_999 * 200 / 10_000 = 199_999.98 → 199_999n truncation
    expect(r.fee).toBe(199_999n);
    expect(r.buyerPaysTotal).toBe(10_199_998n);
  });

  it("legacy circleFee/gasFee fields are always 0n", () => {
    const r = computeMarketplaceCheckout(10_000_000n, 2);
    expect(r.circleFee).toBe(0n);
    expect(r.gasFee).toBe(0n);
  });

  it("zero amount: total is 0n", () => {
    const r = computeMarketplaceCheckout(0n, 1);
    expect(r.itemAmount).toBe(0n);
    expect(r.fee).toBe(0n);
    expect(r.buyerPaysTotal).toBe(0n);
  });

  it("rejects qty < 1", () => {
    expect(() => computeMarketplaceCheckout(1_000_000n, 0)).toThrow(/qty must be >= 1/);
    expect(() => computeMarketplaceCheckout(1_000_000n, -2)).toThrow(/qty must be >= 1/);
  });
});

describe("computeEscrowCheckout — WL/Rekber, 2% buyer fee (no base fee)", () => {
  it("baseFee is 0n (v4 removed the $4 flat fee)", () => {
    for (const unit of [1n, 10_000_000n, 999_999_999n]) {
      const r = computeEscrowCheckout(unit, 1);
      expect(r.baseFee).toBe(0n);
      expect(r.fee).toBe((unit * 200n) / 10_000n);
      expect(r.buyerPaysTotal).toBe(unit + r.fee);
    }
  });

  it("exact math: 10_000_000n unit, qty 1 → total 10_200_000n", () => {
    const r = computeEscrowCheckout(10_000_000n, 1);
    expect(r.itemAmount).toBe(10_000_000n);
    expect(r.fee).toBe(200_000n);
    expect(r.baseFee).toBe(0n);
    expect(r.buyerPaysTotal).toBe(10_200_000n);
  });

  it("legacy circleFee/gasFee fields are always 0n", () => {
    const r = computeEscrowCheckout(10_000_000n, 3);
    expect(r.itemAmount).toBe(30_000_000n);
    expect(r.circleFee).toBe(0n);
    expect(r.gasFee).toBe(0n);
    // 30_000_000 * 300 / 10_000 = 600_000n
    expect(r.fee).toBe(600_000n);
    expect(r.buyerPaysTotal).toBe(30_600_000n);
  });

  it("rejects qty < 1", () => {
    expect(() => computeEscrowCheckout(1_000_000n, 0)).toThrow(/qty must be >= 1/);
  });
});

describe("computeEscrowPayout — WL seller receives 100% (no seller fee)", () => {
  it("no seller fee on WL: seller receives the full price", () => {
    expect(computeEscrowPayout(10_000_000n)).toEqual({
      sellerPayout: 10_000_000n,
      platformFee: 200_000n, // buyer fee only, already collected
    });
  });

  it("zero amount", () => {
    expect(computeEscrowPayout(0n)).toEqual({ sellerPayout: 0n, platformFee: 0n });
  });
});

describe("legacy custodial-era fee helpers — deprecated, always 0n", () => {
  it("estimateCircleFeeMicro always returns 0n", () => {
    expect(estimateCircleFeeMicro(10_000_000n)).toBe(0n);
    expect(estimateCircleFeeMicro(0n)).toBe(0n);
  });

  it("estimateGasMicro always returns 0n (both delivery modes)", () => {
    expect(estimateGasMicro()).toBe(0n);
    expect(estimateGasMicro("instant")).toBe(0n);
    expect(estimateGasMicro("manual")).toBe(0n);
  });

  it("ESTIMATED_GAS_MICRO constant is 0n", () => {
    expect(ESTIMATED_GAS_MICRO).toBe(0n);
  });
});
