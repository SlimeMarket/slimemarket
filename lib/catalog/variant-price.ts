/**
 * Variant price coercion — .
 *
 * Pure helper shared by PUT /api/my/products/[id]/variants (and unit-tested in
 * __tests__/lib/variant-price.test.ts). Converts a per-variant decimal-USDC
 * price into micro-USDC, falling back to the product's base price when the
 * variant price is empty / non-numeric / non-positive.
 *
 * Why: the FE lets sellers leave a variant price blank to mean "use the base
 * price". The old route did `Math.round(parseFloat("") * 1e6)` → NaN → a $0
 * variant that let buyers check out for free. This centralizes the safe
 * fallback so every variant always carries a positive micro price.
 */

export interface VariantPriceInput {
  label?: string;
  price?: number | string | null;
}

export interface CoercedVariant {
  label: string;
  price: number; // micro-USDC
}

/**
 * @param price       raw per-variant price (decimal USDC as number or string)
 * @param baseMicro   product base price in micro-USDC (fallback)
 * @returns micro-USDC price: parsed value when finite & > 0, else baseMicro.
 */
export function coerceVariantPriceMicro(
  price: number | string | null | undefined,
  baseMicro: number,
): number {
  const parsed = parseFloat(String(price ?? ""));
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.round(parsed * 1_000_000);
  }
  return baseMicro;
}

/** Coerce a whole variants array against a base price (micro-USDC). */
export function coerceVariants(
  raw: VariantPriceInput[],
  baseMicro: number,
): CoercedVariant[] {
  return raw.map((v) => ({
    label: String(v.label || "Default").trim() || "Default",
    price: coerceVariantPriceMicro(v.price, baseMicro),
  }));
}
