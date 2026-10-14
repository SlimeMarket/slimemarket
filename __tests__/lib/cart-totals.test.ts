import { describe, it, expect } from "vitest";
import { calculateCartTotals, type CartItem } from "@/lib/store/cart-store";

/**
 * regression guard for the cart total calculation.
 *
 * THE BUG: `calculateCartTotals` fed the subtotal straight into
 * `computeFee(BigInt(subtotal))`. `BigInt(20.5)` does NOT truncate to `20n` — it
 * throws `RangeError: The number 20.5 cannot be converted to a BigInt because it
 * is not an integer`. So a single item whose price was fractional crashed the
 * whole cart page, rather than merely computing a wrong fee.
 *
 * `price` is documented as micro-USDC (an integer) and `CartPage` divides these
 * totals by 1e6, so the fix normalises input defensively instead of trusting it.
 */

const item = (price: number, quantity = 1): CartItem => ({
  id: `i-${price}-${quantity}`,
  productId: "p1",
  quantity,
  productName: "Test",
  price,
  deliveryType: "instant",
});

describe("calculateCartTotals", () => {
  it("computes subtotal + 2% buyer fee for integer micro-USDC prices", () => {
    // 20 USDC item = 20_000_000 micro.
    const t = calculateCartTotals([item(20_000_000)]);
    expect(t.subtotal).toBe(20_000_000);
    expect(t.platformFee).toBe(400_000); // 2%
    expect(t.total).toBe(20_400_000);
  });

  it("does NOT throw on a fractional price (the crash this guards)", () => {
    // Previously: RangeError from BigInt(20.5) → whole cart page down.
    expect(() => calculateCartTotals([item(20.5)])).not.toThrow();
    const t = calculateCartTotals([item(20.5)]);
    // Rounded to the nearest micro-unit, then 2% applied.
    expect(t.subtotal).toBe(21);
    expect(t.platformFee).toBe(0); // 21 * 2% floors to 0
    expect(t.total).toBe(21);
  });

  it("multiplies by quantity", () => {
    const t = calculateCartTotals([item(1_000_000, 3)]);
    expect(t.subtotal).toBe(3_000_000);
    expect(t.platformFee).toBe(60_000);
    expect(t.total).toBe(3_060_000);
  });

  it("ignores zero-quantity lines", () => {
    const t = calculateCartTotals([item(1_000_000, 0), item(500_000, 2)]);
    expect(t.subtotal).toBe(1_000_000);
  });

  it("clamps non-finite and negative input to zero instead of throwing", () => {
    for (const bad of [NaN, Infinity, -Infinity, -5]) {
      expect(() => calculateCartTotals([item(bad)])).not.toThrow();
      expect(calculateCartTotals([item(bad)]).subtotal).toBe(0);
    }
  });

  it("returns zeros for an empty cart", () => {
    expect(calculateCartTotals([])).toEqual({ subtotal: 0, platformFee: 0, total: 0 });
  });

  it("applies the fee to the aggregate, matching the contract's floor rounding", () => {
    // Two 1-micro lines → subtotal 2 → 2 * 200 / 10000 = 0 (integer maths).
    const t = calculateCartTotals([item(1), item(1)]);
    expect(t.subtotal).toBe(2);
    expect(t.platformFee).toBe(0);
    expect(t.total).toBe(2);
  });
});
