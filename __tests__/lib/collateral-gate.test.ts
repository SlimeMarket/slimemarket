import { describe, it, expect } from "vitest";
import { evaluateCollateralGate } from "@/lib/wl/collateral-gate";

/**
 * A2 — the collateral gate.
 *
 * The contract creates AND funds a deal in one call, so collateral can only ever
 * arrive afterwards. This gate is what stops the app from recording a deal as
 * protected while the collateral is missing. Every branch is pinned here because
 * a too-loose gate would let a seller skip the deposit and still get a protected
 * deal — silently removing the buyer's fraud compensation.
 */

const AGREED = 20_000_000n; // 20 USDC in micro-units

describe("evaluateCollateralGate", () => {
  it("passes when the on-chain collateral meets the agreed amount", () => {
    const r = evaluateCollateralGate({
      needsCollateral: true, agreedMicro: AGREED, onChainCollateral: AGREED,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.enforced).toBe(true);
  });

  it("passes when the seller deposited MORE than agreed", () => {
    const r = evaluateCollateralGate({
      needsCollateral: true, agreedMicro: AGREED, onChainCollateral: AGREED * 2n,
    });
    expect(r.ok).toBe(true);
  });

  it("BLOCKS when the on-chain collateral is short", () => {
    const r = evaluateCollateralGate({
      needsCollateral: true, agreedMicro: AGREED, onChainCollateral: AGREED - 1n,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/collateral gate:.*agreed/);
  });

  it("BLOCKS when the collateral was never deposited at all", () => {
    const r = evaluateCollateralGate({
      needsCollateral: true, agreedMicro: AGREED, onChainCollateral: 0n,
    });
    expect(r.ok).toBe(false);
  });

  it("BLOCKS when the deal is missing on-chain", () => {
    const r = evaluateCollateralGate({
      needsCollateral: true, agreedMicro: AGREED, onChainCollateral: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not found on-chain/);
  });

  it("does NOT gate a deal that never required collateral", () => {
    const r = evaluateCollateralGate({
      needsCollateral: false, agreedMicro: 0n, onChainCollateral: 0n,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.enforced).toBe(false);
  });

  it("still reports voluntary collateral on a non-gated deal", () => {
    // Collateral only ever grows, so a seller may add some on a listing that did
    // not require it — the gate must not hide that from the caller.
    const r = evaluateCollateralGate({
      needsCollateral: false, agreedMicro: 0n, onChainCollateral: 5_000_000n,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.onChainCollateral).toBe(5_000_000n);
  });

  it("does not gate a collateral-backed deal whose agreed amount is zero", () => {
    // needsCollateral with 0 agreed is a misconfiguration, but blocking on it
    // would deadlock the deal; zero exposure needs no protection.
    const r = evaluateCollateralGate({
      needsCollateral: true, agreedMicro: 0n, onChainCollateral: 0n,
    });
    expect(r.ok).toBe(true);
  });
});
