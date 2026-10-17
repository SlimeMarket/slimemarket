import { describe, expect, it } from "vitest";
import { gasReserveMicro, MIN_GAS_RESERVE_MICRO } from "@/lib/wallet/gas";
import { explainCircleError, isCircleFailure } from "@/lib/circle/tx-state";

/**
 * Sending "balance − displayed estimate" from /wallet failed on Arc with
 * INSUFFICIENT_NATIVE_TOKEN (USDC is the gas token, and Circle wraps the
 * transfer so its real fee is above the estimate). The reserve must therefore
 * always exceed the plain estimate, and a Circle failure must never be
 * reported as success.
 */
describe("gas reserve for an outbound transfer", () => {
  it("never goes below the hard floor", () => {
    expect(gasReserveMicro(0n)).toBe(MIN_GAS_RESERVE_MICRO);
    expect(gasReserveMicro(1n)).toBe(MIN_GAS_RESERVE_MICRO);
  });

  it("is at least double the plain estimate once the estimate is large", () => {
    // 1 gwei * 60k gas = 60_000 gwei = 0.00006 USDC-equivalent in micro terms
    const gasPrice = 100_000_000_000_000n; // well above the floor
    const estimate = (gasPrice * 60_000n) / 10n ** 12n;
    const reserve = gasReserveMicro(gasPrice);
    expect(reserve).toBeGreaterThanOrEqual(estimate * 2n);
    expect(reserve).toBeGreaterThan(MIN_GAS_RESERVE_MICRO);
  });
});

describe("circle failure reporting", () => {
  it("treats FAILED/CANCELLED/DENIED as terminal failures", () => {
    expect(isCircleFailure("FAILED")).toBe(true);
    expect(isCircleFailure("CANCELLED")).toBe(true);
    expect(isCircleFailure("DENIED")).toBe(true);
    expect(isCircleFailure("COMPLETE")).toBe(false);
    expect(isCircleFailure("PENDING")).toBe(false);
  });

  it("explains the Arc gas shortfall in words a buyer can act on", () => {
    const msg = explainCircleError("INSUFFICIENT_NATIVE_TOKEN");
    expect(msg).toMatch(/network fee/i);
    expect(msg).toMatch(/buffer/i);
  });
});
