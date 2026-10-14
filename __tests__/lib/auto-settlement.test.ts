/**
 * .E — seller auto-settlement decision logic (TDD).
 *
 * Pins the pure decision rules behind the auto-settlement guarantee:
 *   - shouldAutoRelease: overdue SENT orders must auto-release (42h window).
 *   - isSettlementTerminal: idempotency — terminal rows are never re-relayed.
 *   - settlementActionForDisputeResolution: admin decision maps 1:1 to the
 *     relay action ('release' | 'refund') with no manual payout step.
 *   - disputeFinalStatus: the DB status the resolution lands on.
 */
import { describe, expect, it } from "vitest";
import {
  AUTO_RELEASE_WINDOW_HOURS,
  disputeFinalStatus,
  isSettlementTerminal,
  parseReleaseDeadline,
  shouldAutoRelease,
  settlementActionForDisputeResolution,
} from "@/lib/order/auto-settlement";

const HOUR_MS = 60 * 60 * 1000;

describe("shouldAutoRelease — 42h auto-release window", () => {
  const now = new Date("2026-08-09T12:00:00Z");
  const base = { status: "SENT", releaseDeadline: null as string | null };

  it("returns true for a SENT order past its release deadline", () => {
    const deadline = new Date(now.getTime() - 1).toISOString();
    expect(shouldAutoRelease({ ...base, releaseDeadline: deadline }, now)).toBe(true);
  });

  it("returns false while the inspection window is still open", () => {
    const deadline = new Date(now.getTime() + HOUR_MS).toISOString();
    expect(shouldAutoRelease({ ...base, releaseDeadline: deadline }, now)).toBe(false);
  });

  it("returns false at the exact deadline boundary (not overdue yet)", () => {
    expect(shouldAutoRelease({ ...base, releaseDeadline: now.toISOString() }, now)).toBe(false);
  });

  it("returns false when the deadline was never set", () => {
    expect(shouldAutoRelease(base, now)).toBe(false);
  });

  it("returns false when the deadline is paused (dispute nulled it)", () => {
    expect(shouldAutoRelease({ ...base, releaseDeadline: null }, now)).toBe(false);
  });

  it("returns false for non-SENT orders even if overdue", () => {
    const deadline = new Date(now.getTime() - HOUR_MS).toISOString();
    for (const status of ["PENDING", "PROCESS", "DONE", "DISPUTED", "CANCELLED", "DECLINED"]) {
      expect(shouldAutoRelease({ status, releaseDeadline: deadline }, now)).toBe(false);
    }
  });

  it("rejects a garbage deadline string instead of guessing", () => {
    expect(() => shouldAutoRelease({ ...base, releaseDeadline: "not-a-date" }, now)).toThrow(/invalid/);
  });

  it("exposes the 42h window constant", () => {
    expect(AUTO_RELEASE_WINDOW_HOURS).toBe(42);
  });
});

describe("parseReleaseDeadline — defensive date parsing", () => {
  it("parses an ISO string", () => {
    expect(parseReleaseDeadline("2026-08-09T12:00:00.000Z")).toBe(Date.UTC(2026, 7, 9, 12, 0, 0));
  });
  it("returns null for null/empty", () => {
    expect(parseReleaseDeadline(null)).toBeNull();
    expect(parseReleaseDeadline("")).toBeNull();
  });
  it("throws on unparseable input (never silent NaN)", () => {
    expect(() => parseReleaseDeadline("garbage")).toThrow(/invalid/i);
  });
});

describe("isSettlementTerminal — idempotency guard (no double relay)", () => {
  it("terminal on_chain_status values are never re-relayed", () => {
    for (const s of ["RELEASED", "REFUNDED"]) {
      expect(isSettlementTerminal({ status: "DONE", onChainStatus: s })).toBe(true);
    }
  });
  it("pending/failed/null states still need a relay", () => {
    for (const s of ["release_pending", "release_failed", "refund_pending", "refund_failed", "CREATED", null]) {
      expect(isSettlementTerminal({ status: "DONE", onChainStatus: s, onChainOrderId: "7" })).toBe(false);
    }
  });
  it("DONE without an on-chain order id has nothing to relay", () => {
    expect(isSettlementTerminal({ status: "DONE", onChainStatus: null, onChainOrderId: null })).toBe(true);
  });
  it("non-DONE without terminal on-chain status still needs a relay", () => {
    expect(isSettlementTerminal({ status: "SENT", onChainStatus: null, onChainOrderId: "7" })).toBe(false);
  });
});

describe("settlementActionForDisputeResolution", () => {
  it("maps release → release and refund → refund (no manual payout step)", () => {
    expect(settlementActionForDisputeResolution("release")).toBe("release");
    expect(settlementActionForDisputeResolution("refund")).toBe("refund");
  });
  it("rejects unknown decisions", () => {
    // @ts-expect-error — deliberately bad input
    expect(() => settlementActionForDisputeResolution("split")).toThrow(/invalid/i);
  });
});

describe("disputeFinalStatus", () => {
  it("refund resolves to CANCELLED, release resolves to DONE", () => {
    expect(disputeFinalStatus("refund")).toBe("CANCELLED");
    expect(disputeFinalStatus("release")).toBe("DONE");
  });
});
