/**
 * Characterization tests for lib/money.ts .
 *
 * lib/money.ts is the financial-core conversion layer: all amounts are
 * integer micro-USDC (bigint, 6 decimals), never floats. These tests pin the
 * exact parse/format/math semantics at the boundary. If one fails, that is a
 * real money bug — do not adjust the test to match, fix lib/money.ts.
 */
import { describe, it, expect } from "vitest";
import {
  USDC_DECIMALS,
  parseUsdc,
  formatUsdc,
  addUsdc,
  subUsdc,
  percentBps,
} from "@/lib/money";

describe("parseUsdc", () => {
  it("parses whole and fractional amounts to micro-USDC bigint", () => {
    expect(parseUsdc("1")).toBe(1_000_000n);
    expect(parseUsdc("1.23")).toBe(1_230_000n);
    expect(parseUsdc("1.5")).toBe(1_500_000n);
    expect(parseUsdc("0.01")).toBe(10_000n);
    expect(parseUsdc("189.37")).toBe(189_370_000n);
    expect(parseUsdc("0")).toBe(0n);
    expect(parseUsdc("+12")).toBe(12_000_000n); // optional leading +
  });

  it("returns bigint (never Number) for every input", () => {
    for (const v of ["1.23", "0", "999999999999.999999"]) {
      expect(typeof parseUsdc(v)).toBe("bigint");
    }
  });

  it("handles huge values with exact bigint math (no float loss)", () => {
    // 1 trillion USDC — far beyond Number.MAX_SAFE_INTEGER micro units.
    expect(parseUsdc("1000000000000")).toBe(1_000_000_000_000_000_000n);
    // Fractional precision preserved at magnitude:
    expect(parseUsdc("999999999999.999999")).toBe(999_999_999_999_999_999n);
    // Above Number.MAX_SAFE_INTEGER as micro units (2^53 ≈ 9.007e15).
    const big = parseUsdc("12345678901.123456");
    expect(big).toBe(12_345_678_901_123_456n);
    expect(Number.isSafeInteger(Number(big))).toBe(false); // bigint kept it exact
  });

  it("rejects more than 6 decimals (no silent truncation)", () => {
    expect(() => parseUsdc("1.1234567")).toThrow(/too many decimals/);
    expect(() => parseUsdc("0.0000001")).toThrow(/too many decimals/);
  });

  it("accepts exactly 6 decimals", () => {
    expect(parseUsdc("1.123456")).toBe(1_123_456n);
    expect(parseUsdc("0.000001")).toBe(1n);
  });

  it("rejects empty / whitespace / bare dot", () => {
    expect(() => parseUsdc("")).toThrow(/empty input/);
    expect(() => parseUsdc("   ")).toThrow(/empty input/);
    expect(() => parseUsdc(".")).toThrow(/empty input/);
  });

  it("rejects negative values", () => {
    expect(() => parseUsdc("-1")).toThrow(/negative/);
    expect(() => parseUsdc("-0.01")).toThrow(/negative/);
  });

  it("rejects malformed input", () => {
    expect(() => parseUsdc("abc")).toThrow(/malformed/);
    expect(() => parseUsdc("1.2.3")).toThrow(/malformed/);
    expect(() => parseUsdc("1e6")).toThrow(/malformed/); // no exponent notation
    expect(() => parseUsdc("1,000")).toThrow(/malformed/); // no thousands sep
    expect(() => parseUsdc(".5")).toThrow(/malformed/); // requires digit before dot
  });

  it("trims surrounding whitespace", () => {
    expect(parseUsdc("  1.5  ")).toBe(1_500_000n);
  });

  it("accepts finite non-negative numbers via toFixed(6)", () => {
    expect(parseUsdc(1.5)).toBe(1_500_000n);
    expect(parseUsdc(0)).toBe(0n);
    expect(() => parseUsdc(-1)).toThrow(/invalid number/);
    expect(() => parseUsdc(Number.NaN)).toThrow(/invalid number/);
    expect(() => parseUsdc(Number.POSITIVE_INFINITY)).toThrow(/invalid number/);
  });
});

describe("formatUsdc", () => {
  it("formats with trailing-zero trimming", () => {
    expect(formatUsdc(1_230_000n)).toBe("1.23");
    expect(formatUsdc(1_000_000n)).toBe("1");
    expect(formatUsdc(189_370_000n)).toBe("189.37");
    expect(formatUsdc(10_000n)).toBe("0.01");
    expect(formatUsdc(1n)).toBe("0.000001");
    expect(formatUsdc(500_000n)).toBe("0.5");
    expect(formatUsdc(0n)).toBe("0");
  });

  it("round-trips parse → format → parse exactly", () => {
    const samples = ["1.23", "0.01", "189.37", "1000000", "0.000001", "999999999999.999999"];
    for (const s of samples) {
      const micro = parseUsdc(s);
      expect(parseUsdc(formatUsdc(micro))).toBe(micro);
    }
  });

  it("handles huge values without float artifacts", () => {
    expect(formatUsdc(1_000_000_000_000_000_000n)).toBe("1000000000000");
    expect(formatUsdc(999_999_999_999_999_999n)).toBe("999999999999.999999");
  });

  it("rejects negative micro amounts", () => {
    expect(() => formatUsdc(-1n)).toThrow(/negative/);
  });
});

describe("addUsdc / subUsdc", () => {
  it("adds and subtracts exactly", () => {
    expect(addUsdc(1_230_000n, 770_000n)).toBe(2_000_000n);
    expect(subUsdc(2_000_000n, 770_000n)).toBe(1_230_000n);
    expect(subUsdc(5n, 5n)).toBe(0n);
  });

  it("subUsdc throws on underflow (no negative balances)", () => {
    expect(() => subUsdc(1n, 2n)).toThrow(/underflow/);
  });
});

describe("percentBps", () => {
  it("computes basis-point percentages in bigint with truncation", () => {
    expect(percentBps(10_000_000n, 200)).toBe(200_000n); // 2%
    expect(percentBps(10_000_000n, 10_000)).toBe(10_000_000n); // 100%
    expect(percentBps(0n, 200)).toBe(0n);
    // Truncation toward zero: 999_999 * 200 / 10_000 = 19_999.98 → 19_999
    expect(percentBps(999_999n, 200)).toBe(19_999n);
  });

  it("rejects negative bps", () => {
    expect(() => percentBps(1_000_000n, -1)).toThrow(/negative bps/);
  });
});

describe("USDC_DECIMALS", () => {
  it("is 6", () => {
    expect(USDC_DECIMALS).toBe(6);
  });
});
