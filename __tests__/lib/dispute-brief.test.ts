import { describe, expect, it } from "vitest";
import { buildDisputeBrief, type DealForBrief } from "@/lib/disputes/brief";

/**
 * The dispute brief exists to remove the clerical work of assembling a case for
 * a HUMAN arbitrator. It must never drift into deciding the case.
 *
 * These tests pin both halves: the facts it computes, and the things it is
 * forbidden from containing (no verdict, no AI, no recommendation).
 */

const NOW = new Date("2026-10-07T12:00:00.000Z");

function deal(over: Partial<DealForBrief> = {}): DealForBrief {
  return {
    price: "500000",
    sellerCollateral: "50000",
    deliveredAt: null,
    deliveryDeadline: "2026-10-12T00:00:00.000Z",
    confirmDeadline: null,
    disputedAt: "2026-10-07T00:00:00.000Z",
    onChainDealId: "26",
    onChainStatus: "CREATED",
    collateralSlashed: "0",
    ...over,
  };
}

describe("buildDisputeBrief — facts", () => {
  it("reads the money straight off the deal", () => {
    const b = buildDisputeBrief({ deal: deal(), now: NOW });
    expect(b.facts.priceMicro).toBe("500000");
    expect(b.facts.collateralMicro).toBe("50000");
  });

  it("treats a null money field as zero rather than NaN", () => {
    const b = buildDisputeBrief({ deal: deal({ price: null, sellerCollateral: null }), now: NOW });
    expect(b.facts.priceMicro).toBe("0");
    expect(b.facts.collateralMicro).toBe("0");
  });

  it("reports deadlines as passed / not yet, relative to now", () => {
    const b = buildDisputeBrief({
      deal: deal({ deliveryDeadline: "2026-10-01T00:00:00.000Z" }),
      now: NOW,
    });
    expect(b.facts.deliveryDeadlinePassed).toBe(true);
  });

  it("leaves a deadline null (not false) when the deal has none", () => {
    const b = buildDisputeBrief({ deal: deal({ deliveryDeadline: null }), now: NOW });
    // null means "unknown", false would mean "checked and not passed".
    expect(b.facts.deliveryDeadlinePassed).toBeNull();
  });

  it("computes the dispute backstop as disputedAt + 30 days", () => {
    const b = buildDisputeBrief({ deal: deal(), now: NOW });
    expect(b.facts.disputeBackstopAt).toBe("2026-11-06T00:00:00.000Z");
    expect(b.facts.disputeBackstopPassed).toBe(false);
  });

  it("flags the backstop once it has elapsed", () => {
    const b = buildDisputeBrief({
      deal: deal({ disputedAt: "2026-08-01T00:00:00.000Z" }),
      now: NOW,
    });
    expect(b.facts.disputeBackstopPassed).toBe(true);
  });

  it("carries the delivered marker through", () => {
    const b = buildDisputeBrief({ deal: deal({ deliveredAt: "2026-10-06T00:00:00.000Z" }), now: NOW });
    expect(b.facts.delivered).toBe(true);
  });
});

describe("buildDisputeBrief — claims", () => {
  it("splits evidence by side, oldest first", () => {
    const b = buildDisputeBrief({
      deal: deal(),
      now: NOW,
      evidence: [
        { side: "seller", note: "later", at: "2026-10-07T05:00:00.000Z" },
        { side: "buyer", note: "first", at: "2026-10-07T01:00:00.000Z" },
        { side: "seller", note: "earlier", at: "2026-10-07T03:00:00.000Z" },
      ],
    });
    expect(b.claims.buyer.map((c) => c.note)).toEqual(["first"]);
    expect(b.claims.seller.map((c) => c.note)).toEqual(["earlier", "later"]);
  });

  it("drops evidence with an unrecognised side instead of guessing", () => {
    const b = buildDisputeBrief({
      deal: deal(),
      now: NOW,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      evidence: [{ side: "third-party", note: "x", at: NOW.toISOString() } as any],
    });
    expect(b.claims.buyer).toHaveLength(0);
    expect(b.claims.seller).toHaveLength(0);
  });

  it("survives a null evidence list", () => {
    const b = buildDisputeBrief({ deal: deal(), now: NOW, evidence: null });
    expect(b.claims.buyer).toEqual([]);
    expect(b.claims.seller).toEqual([]);
  });
});

describe("buildDisputeBrief — availability mirrors the CONTRACT, not judgement", () => {
  it("all three are open on a funded, unresolved deal with collateral", () => {
    const b = buildDisputeBrief({ deal: deal(), now: NOW });
    expect(b.availability.release.available).toBe(true);
    expect(b.availability.refund.available).toBe(true);
    expect(b.availability.slash.available).toBe(true);
  });

  it("slash is UNAVAILABLE when no collateral was deposited", () => {
    // refundEscrowWithSlash requires collateral > 0.
    const b = buildDisputeBrief({ deal: deal({ sellerCollateral: "0" }), now: NOW });
    expect(b.availability.slash.available).toBe(false);
    expect(b.availability.slash.reason).toMatch(/nothing to slash/i);
    // The other two stay open — that is the point.
    expect(b.availability.release.available).toBe(true);
    expect(b.availability.refund.available).toBe(true);
  });

  it("everything is UNAVAILABLE once the deal is resolved on-chain", () => {
    const b = buildDisputeBrief({ deal: deal({ onChainStatus: "REFUNDED" }), now: NOW });
    expect(b.availability.release.available).toBe(false);
    expect(b.availability.refund.available).toBe(false);
    expect(b.availability.slash.available).toBe(false);
    expect(b.availability.release.reason).toMatch(/already resolved/i);
  });

  it("everything is UNAVAILABLE without an on-chain id", () => {
    const b = buildDisputeBrief({ deal: deal({ onChainDealId: null }), now: NOW });
    expect(b.availability.release.available).toBe(false);
    expect(b.availability.refund.available).toBe(false);
    expect(b.availability.slash.available).toBe(false);
  });

  it('says "available", never "recommended" — availability is not correctness', () => {
    const b = buildDisputeBrief({ deal: deal(), now: NOW });
    // Assert on the KEYS, not the whole payload: the disclaimer legitimately
    // contains the word "recommend" (to say it does NOT recommend anything).
    const keys = JSON.stringify(b);
    expect(keys).not.toMatch(/"recommendation"/i);
    expect(keys).not.toMatch(/"suggested/i);
    expect(keys).not.toMatch(/"verdict"/i);
    // The disclaimer must be present so no consumer can mistake the payload.
    expect(b.disclaimer).toMatch(/does not recommend/i);
  });

  it("has no field an AI verdict could be smuggled into", () => {
    const b = buildDisputeBrief({ deal: deal(), now: NOW });
    expect(Object.keys(b).sort()).toEqual(
      ["availability", "claims", "disclaimer", "facts", "generatedAt", "reason"].sort(),
    );
  });
});
