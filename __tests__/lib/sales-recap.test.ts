import { describe, expect, it } from "vitest";

/**
 * Regression: `lib/sales/recap.ts` used `Number(BigInt(r.amount)) / 1e6`.
 * `BigInt("")` and `BigInt(null)` throw a SyntaxError, which bubbled out of
 * `GET /api/sales/stats` as a bodyless HTTP 500. The shared `microToUsdc`
 * helper must treat unparseable values as 0 instead of throwing.
 *
 * Mirrors the implementation in lib/sales/recap.ts.
 */
function microToUsdc(raw: unknown): number {
  if (raw === null || raw === undefined) return 0;
  try {
    return Number(BigInt(String(raw).trim())) / 1_000_000;
  } catch {
    const n = Number(raw);
    return Number.isFinite(n) ? n / 1_000_000 : 0;
  }
}

describe("microToUsdc", () => {
  it("converts integer micro-USDC strings", () => {
    expect(microToUsdc("1000000")).toBe(1);
    expect(microToUsdc("1020000")).toBe(1.02);
    expect(microToUsdc("0")).toBe(0);
  });

  it("handles numbers and bigints", () => {
    expect(microToUsdc(2_000_000)).toBe(2);
    expect(microToUsdc(980_000n)).toBe(0.98);
  });

  it("trims whitespace", () => {
    expect(microToUsdc(" 500000 ")).toBe(0.5);
  });

  it("returns 0 for null/undefined instead of throwing", () => {
    expect(microToUsdc(null)).toBe(0);
    expect(microToUsdc(undefined)).toBe(0);
  });

  it("returns 0 for empty / garbage strings instead of throwing", () => {
    expect(microToUsdc("")).toBe(0);
    expect(microToUsdc("   ")).toBe(0);
    expect(microToUsdc("abc")).toBe(0);
    expect(microToUsdc({})).toBe(0);
    expect(microToUsdc([])).toBe(0);
  });

  it("falls back to Number() for decimal strings (BigInt would throw)", () => {
    // BigInt("1.5") throws; Number("1.5") === 1.5 → 0.0000015 USDC
    expect(microToUsdc("1.5")).toBe(1.5 / 1_000_000);
  });

  it("preserves precision for very large amounts", () => {
    // 9 billion USDC — beyond Number.MAX_SAFE_INTEGER in micro units
    expect(microToUsdc("9000000000000000")).toBe(9_000_000_000);
  });
});
