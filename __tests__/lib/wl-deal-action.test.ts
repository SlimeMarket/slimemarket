import { describe, it, expect } from "vitest";
import {
  WL_DEAL_ACTION_SELECTORS,
  validateDealActionTx,
  type DealActionExpectation,
} from "@/lib/wl/eoa";

/**
 * Guard for the single-arg escrow lifecycle validators.
 *
 * WHY THIS MATTERS: these routes accept a client-supplied tx hash and then trust
 * it to settle a deal. A selector that silently does not match the contract (the
 * escrow-events bug class) or a sender check that is too loose would let anyone
 * settle someone else's deal. Every rejection path is pinned here.
 */

const ESCROW = "0x39908c1a572277a5a2eb615bde9be0e7ea55e4c6";
const SELLER = "0x6b53a8fc9c7B810DB7d2904159ab4923406bD1E9";
const BUYER = "0x0b2aC77006A1f4b12Bb85d8F016222250b7465cA";
const OTHER = "0x1111111111111111111111111111111111111111";

/** Build calldata: selector + one uint256 (dealId) as a 32-byte word. */
function calldata(selector: string, dealId: bigint): string {
  return selector + dealId.toString(16).padStart(64, "0");
}

function base(overrides: Partial<{ to: string; status: string; sender: string; input: string }> = {}) {
  return {
    to: ESCROW,
    status: "success",
    sender: SELLER,
    input: calldata(WL_DEAL_ACTION_SELECTORS.markDelivered, 7n),
    ...overrides,
  };
}

function expect_(overrides: Partial<DealActionExpectation> = {}): DealActionExpectation {
  return {
    escrowAddress: ESCROW,
    allowedSenders: [SELLER],
    onChainDealId: "7",
    action: "markDelivered",
    ...overrides,
  };
}

describe("WL deal action selectors", () => {
  it("are derived from the signatures (never hand-typed)", () => {
    // Pinned so a signature typo cannot silently change the selector — this is
    // exactly the drift that made parseEventLogs skip escrow logs undetected.
    expect(WL_DEAL_ACTION_SELECTORS.markDelivered).toBe("0xeb826a5f");
    expect(WL_DEAL_ACTION_SELECTORS.confirmEscrow).toBe("0x0b12c37f");
    expect(WL_DEAL_ACTION_SELECTORS.flagDispute).toBe("0xdaac3868");
  });
});

describe("validateDealActionTx", () => {
  it("accepts a well-formed markDelivered tx and returns the sender", () => {
    expect(validateDealActionTx(base(), expect_())).toBe(SELLER.toLowerCase());
  });

  it("rejects a reverted tx", () => {
    expect(() => validateDealActionTx(base({ status: "reverted" }), expect_()))
      .toThrow(/status must be 'success'/);
  });

  it("rejects a tx sent to something other than the escrow contract", () => {
    expect(() => validateDealActionTx(base({ to: OTHER }), expect_()))
      .toThrow(/must target the escrow contract/);
  });

  it("rejects a sender that is not an allowed party", () => {
    expect(() => validateDealActionTx(base({ sender: OTHER }), expect_()))
      .toThrow(/sender must be/);
  });

  it("rejects the WRONG function even when the args look fine", () => {
    // A confirmEscrow calldata offered as a markDelivered call must not pass —
    // otherwise a buyer could settle the deal without the seller ever delivering.
    const wrong = calldata(WL_DEAL_ACTION_SELECTORS.confirmEscrow, 7n);
    expect(() => validateDealActionTx(base({ input: wrong }), expect_()))
      .toThrow(/must call markDelivered\(uint256\)/);
  });

  it("rejects calldata for a DIFFERENT deal", () => {
    const other = calldata(WL_DEAL_ACTION_SELECTORS.markDelivered, 99n);
    expect(() => validateDealActionTx(base({ input: other }), expect_()))
      .toThrow(/does not match deal/);
  });

  it("rejects malformed calldata (wrong arg count)", () => {
    const twoArgs = WL_DEAL_ACTION_SELECTORS.markDelivered
      + "0".repeat(64) + "0".repeat(64);
    expect(() => validateDealActionTx(base({ input: twoArgs }), expect_()))
      .toThrow(/expected exactly one uint256 arg/);
  });

  it("rejects an empty input", () => {
    expect(() => validateDealActionTx(base({ input: "0x" }), expect_()))
      .toThrow(/must call markDelivered/);
  });

  it("rejects a non-numeric on-chain deal id", () => {
    expect(() => validateDealActionTx(base(), expect_({ onChainDealId: "abc" })))
      .toThrow(/no numeric on-chain deal id/);
  });

  it("treats deal id 0 as valid (the first deal is not falsy)", () => {
    const input = calldata(WL_DEAL_ACTION_SELECTORS.markDelivered, 0n);
    expect(validateDealActionTx(base({ input }), expect_({ onChainDealId: "0" })))
      .toBe(SELLER.toLowerCase());
  });

  it("accepts EITHER party for flagDispute", () => {
    const input = calldata(WL_DEAL_ACTION_SELECTORS.flagDispute, 7n);
    const e = expect_({ action: "flagDispute", allowedSenders: [BUYER, SELLER] });
    expect(validateDealActionTx(base({ input, sender: BUYER }), e)).toBe(BUYER.toLowerCase());
    expect(validateDealActionTx(base({ input, sender: SELLER }), e)).toBe(SELLER.toLowerCase());
    expect(() => validateDealActionTx(base({ input, sender: OTHER }), e)).toThrow(/sender must be/);
  });

  it("compares addresses case-insensitively", () => {
    expect(validateDealActionTx(base({ sender: SELLER.toUpperCase() }), expect_()))
      .toBe(SELLER.toLowerCase());
  });
});
