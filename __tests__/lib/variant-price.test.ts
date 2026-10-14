import { describe, it, expect } from "vitest";
import { coerceVariantPriceMicro, coerceVariants } from "@/lib/catalog/variant-price";

/**
 * variant price coercion. The FE lets a seller leave a variant
 * price blank to mean "use the base price". The old route turned an empty
 * string into NaN → Math.round(NaN) → a $0 variant that let buyers check out
 * for free. These tests pin the safe fallback.
 */
const BASE = 5_000_000; // $5.00 base price, micro-USDC

describe("coerceVariantPriceMicro", () => {
  it("empty string → base price", () => {
    expect(coerceVariantPriceMicro("", BASE)).toBe(BASE);
  });
  it("null/undefined → base price", () => {
    expect(coerceVariantPriceMicro(null, BASE)).toBe(BASE);
    expect(coerceVariantPriceMicro(undefined, BASE)).toBe(BASE);
  });
  it("non-numeric → base price", () => {
    expect(coerceVariantPriceMicro("abc", BASE)).toBe(BASE);
  });
  it("zero → base price (never a free variant)", () => {
    expect(coerceVariantPriceMicro("0", BASE)).toBe(BASE);
    expect(coerceVariantPriceMicro(0, BASE)).toBe(BASE);
  });
  it("negative → base price", () => {
    expect(coerceVariantPriceMicro("-3", BASE)).toBe(BASE);
  });
  it("valid decimal → micro conversion", () => {
    expect(coerceVariantPriceMicro("2.5", BASE)).toBe(2_500_000);
    expect(coerceVariantPriceMicro(10, BASE)).toBe(10_000_000);
  });
  it("rounds sub-micro precision", () => {
    expect(coerceVariantPriceMicro("1.9999999", BASE)).toBe(2_000_000);
  });
});

describe("coerceVariants", () => {
  it("trims labels, defaults empty labels, applies base-price fallback", () => {
    const out = coerceVariants(
      [
        { label: "  1 month  ", price: "3" },
        { label: "", price: "" },
        { label: "3 months", price: "0" },
      ],
      BASE,
    );
    expect(out).toEqual([
      { label: "1 month", price: 3_000_000 },
      { label: "Default", price: BASE },
      { label: "3 months", price: BASE },
    ]);
  });
});
