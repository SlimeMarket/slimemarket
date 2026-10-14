import { describe, it, expect } from "vitest";
import {
  hasOnChainOrder,
  resolveSettlementRail,
  unresolvedRailError,
} from "@/lib/order/settlement-rail";

/**
 * regression guard for the double-payout / no-payout bug.
 *
 * The rail must be derived from the ORDER (`on_chain_order_id`), never from the
 * current value of `ONCHAIN_FUNDS_ENABLED`. The old code mixed the two, so
 * flipping the flag between order creation and settlement either paid the
 * seller twice (ledger credit + on-chain release) or paid them nothing while
 * still marking the order DONE.
 */
describe("hasOnChainOrder", () => {
  it('treats "0" as a REAL contract id (the first order)', () => {
    expect(hasOnChainOrder("0")).toBe(true);
  });

  it("treats other id strings as present", () => {
    expect(hasOnChainOrder("42")).toBe(true);
    expect(hasOnChainOrder(" 7 ")).toBe(true);
  });

  it("treats null / undefined / empty as absent", () => {
    expect(hasOnChainOrder(null)).toBe(false);
    expect(hasOnChainOrder(undefined)).toBe(false);
    expect(hasOnChainOrder("")).toBe(false);
    expect(hasOnChainOrder("   ")).toBe(false);
  });
});

describe("resolveSettlementRail", () => {
  it("routes a funded order on-chain regardless of the flag", () => {
    // Both flag values must agree: the money is in MarketEscrow either way.
    expect(
      resolveSettlementRail({ onChainOrderId: "0", onchainFundsEnabled: true }),
    ).toBe("on-chain");
    expect(
      resolveSettlementRail({ onChainOrderId: "0", onchainFundsEnabled: false }),
    ).toBe("on-chain");
  });

  it("routes an id-less order to the ledger when the flag is off (custodial)", () => {
    expect(
      resolveSettlementRail({ onChainOrderId: null, onchainFundsEnabled: false }),
    ).toBe("ledger");
  });

  it("flags the unresolved anomaly when the flag is on but no id exists", () => {
    // Non-custodial mode + no contract id = the relay reached Circle but the id
    // was never read back. Settling here would either mint ledger money or mark
    // the order DONE with no payout, so it must NOT be settled.
    expect(
      resolveSettlementRail({ onChainOrderId: null, onchainFundsEnabled: true }),
    ).toBe("unresolved");
  });

  it("THE REGRESSION: the rail never changes with the flag for a funded order", () => {
    // This is the exact shape of the old double-payout: the ledger credit used
    // to key off the flag while the relay keyed off the id.
    const funded = { onChainOrderId: "5" as string | null };
    const withFlagOff = resolveSettlementRail({ ...funded, onchainFundsEnabled: false });
    const withFlagOn = resolveSettlementRail({ ...funded, onchainFundsEnabled: true });
    expect(withFlagOff).toBe(withFlagOn);
    expect(withFlagOff).toBe("on-chain");
  });
});

describe("unresolvedRailError", () => {
  it("is a typed 409 so routes surface it instead of a generic 500", () => {
    const e = unresolvedRailError();
    expect(e.httpStatus).toBe(409);
    expect(e.code).toBe("ONCHAIN_ID_UNRESOLVED");
    expect(e.message).toMatch(/not settled on-chain yet/);
    // Must make clear that nothing was paid out.
    expect(e.message).toMatch(/No funds have been released/);
  });
});
