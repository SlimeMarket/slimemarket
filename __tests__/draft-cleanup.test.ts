import { describe, it, expect, vi } from "vitest";

// B3 — stuck-instant-draft eligibility (TDD).

// isStuckInstantDraft is the PURE eligibility decision used by the draft
// sweep (lib/order/draft-cleanup.ts) to find orders that got credentials
// attached at confirm time (SENT) but whose createOrderFor relay never
// produced an on-chain escrow — their stock rows sit 'sold' forever while
// the buyer never paid. Those orders get CANCELLED + restocked.

import { isStuckInstantDraft, type StuckDraftRow } from "@/lib/order/draft-cleanup";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const TWO_HOURS_AGO = "2026-08-09T10:00:00.000Z"; // older than 1h TTL
const THIRTY_MIN_AGO = "2026-08-09T11:30:00.000Z"; // newer than 1h TTL

/** Baseline row that IS a stuck instant draft. */
function stuckRow(overrides: Partial<StuckDraftRow> = {}): StuckDraftRow {
  return {
    status: "SENT",
    delivery: "instant",
    payment: "Onchain",
    on_chain_order_id: null,
    on_chain_tx_hash: null,
    created_at: TWO_HOURS_AGO,
    ...overrides,
  };
}

describe("isStuckInstantDraft — eligible", () => {
  it("accepts a SENT instant Onchain draft older than 1h with no on-chain refs", () => {
    expect(isStuckInstantDraft(stuckRow(), NOW)).toBe(true);
  });

  it("treats empty-string and whitespace-only on_chain_tx_hash as no-ref", () => {
    expect(isStuckInstantDraft(stuckRow({ on_chain_tx_hash: "" }), NOW)).toBe(true);
    expect(isStuckInstantDraft(stuckRow({ on_chain_tx_hash: "   " }), NOW)).toBe(true);
  });

  it("accepts a row exactly at the TTL cutoff (created <= cutoff)", () => {
    const exactlyAtCutoff = new Date(NOW.getTime() - 60 * 60_000).toISOString();
    expect(isStuckInstantDraft(stuckRow({ created_at: exactlyAtCutoff }), NOW)).toBe(true);
  });

  it("supports an injected TTL (60 min default)", () => {
    expect(isStuckInstantDraft(stuckRow({ created_at: THIRTY_MIN_AGO }), NOW, 15)).toBe(true);
    expect(isStuckInstantDraft(stuckRow({ created_at: THIRTY_MIN_AGO }), NOW, 120)).toBe(false);
  });
});

describe("isStuckInstantDraft — disqualified", () => {
  it("rejects non-SENT statuses", () => {
    for (const status of ["PENDING", "PROCESS", "DONE", "CANCELLED", "DECLINED", "DISPUTED"]) {
      expect(isStuckInstantDraft(stuckRow({ status }), NOW)).toBe(false);
    }
  });

  it("rejects manual-delivery orders", () => {
    expect(isStuckInstantDraft(stuckRow({ delivery: "manual" }), NOW)).toBe(false);
  });

  it("rejects custodial orders (payment != Onchain) in CUSTODIAL mode — already PAID", () => {
    vi.stubEnv("ONCHAIN_WALLET_FUNDS", "");
    expect(isStuckInstantDraft(stuckRow({ payment: "Balance" }), NOW)).toBe(false);
    expect(isStuckInstantDraft(stuckRow({ payment: "Direct" }), NOW)).toBe(false);
    vi.unstubAllEnvs();
  });

  // BUG 13 — MONEY SAFETY / LIVENESS. In non-custodial mode nothing has
  // been debited from anyone, so a SENT + no-on-chain-id row is an abandoned
  // draft REGARDLESS of its payment label. The legacy `checkoutOrder` path could
  // mint `payment='Balance'` rows whose escrow relay then failed; because the
  // eligibility check required `payment === "Onchain"`, those rows were never
  // swept AND `confirmOrder` correctly refused them with ONCHAIN_ID_UNRESOLVED —
  // so they stuck forever (two live orders were wedged this way).
  it("ELIGIBLE in non-custodial mode even when payment='Balance' (BUG 13)", () => {
    vi.stubEnv("ONCHAIN_WALLET_FUNDS", "1");
    expect(isStuckInstantDraft(stuckRow({ payment: "Balance" }), NOW)).toBe(true);
    vi.unstubAllEnvs();
  });

  it("still rejects a 'Balance' row in non-custodial mode if it reached the chain", () => {
    vi.stubEnv("ONCHAIN_WALLET_FUNDS", "1");
    // Settled custodial money — reconciliation owns it, never the sweeper.
    expect(
      isStuckInstantDraft(stuckRow({ payment: "Balance", on_chain_order_id: "7" }), NOW),
    ).toBe(false);
    expect(
      isStuckInstantDraft(
        stuckRow({ payment: "Balance", on_chain_circle_tx_id: "circle-tx-9" }),
        NOW,
      ),
    ).toBe(false);
    vi.unstubAllEnvs();
  });

  it("rejects orders that reached the chain (on_chain_order_id set)", () => {
    expect(isStuckInstantDraft(stuckRow({ on_chain_order_id: "42" }), NOW)).toBe(false);
  });

  it("rejects orders that reached the chain (on_chain_tx_hash set)", () => {
    expect(
      isStuckInstantDraft(
        stuckRow({ on_chain_tx_hash: "0xabc123def456" }),
        NOW,
      ),
    ).toBe(false);
  });

  // MONEY SAFETY. A stored Circle tx id means the createOrderFor relay
  // WAS submitted, even when the contract order id could not be resolved in time.
  // In that case the buyer's USDC is already in MarketEscrow; cancelling and
  // restocking here would strand it with no id left to refund against.
  it("rejects a row whose relay was submitted (on_chain_circle_tx_id set)", () => {
    expect(
      isStuckInstantDraft(stuckRow({ on_chain_circle_tx_id: "circle-tx-123" }), NOW),
    ).toBe(false);
  });

  it("treats empty/whitespace on_chain_circle_tx_id as not submitted", () => {
    expect(isStuckInstantDraft(stuckRow({ on_chain_circle_tx_id: "" }), NOW)).toBe(true);
    expect(isStuckInstantDraft(stuckRow({ on_chain_circle_tx_id: "   " }), NOW)).toBe(true);
  });

  it("rejects drafts newer than the TTL", () => {
    expect(isStuckInstantDraft(stuckRow({ created_at: THIRTY_MIN_AGO }), NOW)).toBe(false);
  });

  it("rejects unparseable created_at (never sweeps on garbage)", () => {
    expect(isStuckInstantDraft(stuckRow({ created_at: "not-a-date" }), NOW)).toBe(false);
  });
});
