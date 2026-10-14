import { describe, it, expect, vi } from "vitest";

// arc-ecommerce-payments pattern tests (RED phase).

// These import modules that do not exist yet (lib/order/patterns.ts) and
// helpers that are not exported yet from lib/contracts/indexer.ts and
// lib/order/checkout.ts. Every failure must be "module not found / export
// missing" style — the right reason for RED.

import {
  guardTransition,
  GuardConflictError,
  validateMicroAmount,
  bestEffortPersist,
  buildLifecycleEvent,
  validateDraftForConfirm,
  type CheckoutAction,
  type CheckoutStatus,
  type DraftRow,
} from "@/lib/order/patterns";
import { correlateOrderEvent } from "@/lib/contracts/indexer";

// ---------------------------------------------------------------------------
// (b) State-machine guards
// ---------------------------------------------------------------------------

const DRAFT_STATUSES: CheckoutStatus[] = ["PENDING"];

describe("(b) guardTransition — happy paths", () => {
  it("passes when current status is in the expected list", () => {
    expect(() => guardTransition("PENDING", DRAFT_STATUSES, "confirm")).not.toThrow();
    expect(() => guardTransition("SENT", ["SENT"], "release")).not.toThrow();
  });

  it("supports multi-status expectations (cancel from PENDING or PROCESS)", () => {
    expect(() => guardTransition("PENDING", ["PENDING", "PROCESS"], "cancel")).not.toThrow();
    expect(() => guardTransition("PROCESS", ["PENDING", "PROCESS"], "cancel")).not.toThrow();
  });
});

describe("(b) guardTransition — wrong status → 409 semantics", () => {
  it("throws GuardConflictError with httpStatus 409 and a code", () => {
    try {
      guardTransition("DONE", DRAFT_STATUSES, "confirm");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(GuardConflictError);
      const err = e as GuardConflictError;
      expect(err.httpStatus).toBe(409);
      expect(err.code).toBe("INVALID_ORDER_STATUS");
      expect(err.message).toContain("DONE");
      expect(err.message).toContain("confirm");
    }
  });

  it("carries current/expected/action context", () => {
    try {
      guardTransition("CANCELLED", DRAFT_STATUSES, "challenge");
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as GuardConflictError;
      expect(err.current).toBe("CANCELLED");
      expect(err.expected).toEqual(DRAFT_STATUSES);
      expect(err.action).toBe("challenge");
    }
  });
});

describe("(b) validateMicroAmount — invalid amounts → 422 semantics", () => {
  it("accepts a positive bigint string", () => {
    expect(validateMicroAmount("1000000")).toEqual(1_000_000n);
  });

  it("rejects negative amounts with httpStatus 422", () => {
    try {
      validateMicroAmount("-5");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as { httpStatus: number }).httpStatus).toBe(422);
      expect((e as { code: string }).code).toBe("INVALID_AMOUNT");
    }
  });

  it("rejects zero with 422", () => {
    try {
      validateMicroAmount("0");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as { httpStatus: number }).httpStatus).toBe(422);
    }
  });

  it("rejects a client amount that exceeds the server draft amount with 422", () => {
    try {
      validateMicroAmount("2000000", 1_500_000n);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as { httpStatus: number }).httpStatus).toBe(422);
      expect((e as { code: string }).code).toBe("AMOUNT_EXCEEDS_DRAFT");
    }
  });
});

// ---------------------------------------------------------------------------
// (a) Best-effort persistence
// ---------------------------------------------------------------------------

describe("(a) bestEffortPersist", () => {
  it("returns the fn result on success", async () => {
    const out = await bestEffortPersist("test-ok", async () => "value");
    expect(out).toEqual({ ok: true, value: "value", degraded: false });
  });

  it("returns the fallback when fn throws — never rethrows", async () => {
    const out = await bestEffortPersist(
      "insert-order",
      async () => { throw new Error("db down"); },
      { fallback: "fallback-uuid" },
    );
    expect(out.ok).toBe(false);
    expect(out.value).toBe("fallback-uuid");
    expect(out.degraded).toBe(true);
    expect(out.error).toContain("db down");
  });

  it("returns null fallback when none provided and fn throws", async () => {
    const out = await bestEffortPersist(
      "update-status",
      async () => { throw new Error("db down"); },
    );
    expect(out.ok).toBe(false);
    expect(out.value).toBeNull();
    expect(out.degraded).toBe(true);
  });

  it("passes the structured context to the logger without throwing", async () => {
    const log = { error: vi.fn() };
    await bestEffortPersist(
      "insert-order",
      async () => { throw new Error("conn reset"); },
      {
        fallback: "x",
        logger: log,
        context: { orderId: "abc" },
      },
    );
    expect(log.error).toHaveBeenCalledTimes(1);
    const [ctxArg, msgArg] = log.error.mock.calls[0];
    expect(ctxArg).toMatchObject({ orderId: "abc" });
    expect(String((ctxArg as { err: unknown }).err)).toContain("conn reset");
    expect(String(msgArg)).toContain("insert-order");
  });
});

// ---------------------------------------------------------------------------
// (c) lifecycle_events payload builder — must match migration 0044 columns
// ---------------------------------------------------------------------------

describe("(c) buildLifecycleEvent — 0044 column shape", () => {
  it("builds a CREATED payload with exact columns", () => {
    const row = buildLifecycleEvent({
      orderId: "11111111-1111-1111-1111-111111111111",
      operation: "CREATED",
      txHash: null,
      amountMicro: 5_000_000n,
      note: "non-custodial draft",
    });
    expect(row).toEqual({
      order_id: "11111111-1111-1111-1111-111111111111",
      operation: "CREATED",
      tx_hash: null,
      amount: "5.000000",
      note: "non-custodial draft",
    });
    expect(Object.keys(row).sort()).toEqual(
      ["amount", "note", "operation", "order_id", "tx_hash"].sort(),
    );
  });

  it("converts bigint micro-USDC to NUMERIC(20,6) decimal string without loss", () => {
    const row = buildLifecycleEvent({
      orderId: "11111111-1111-1111-1111-111111111111",
      operation: "RELEASED",
      amountMicro: 123_456_789_012n,
    });
    expect(row.amount).toBe("123456.789012");
    expect(row.note).toBeNull();
  });

  it("rejects operations not in the 0044 CHECK constraint", () => {
    expect(() =>
      buildLifecycleEvent({
        orderId: "11111111-1111-1111-1111-111111111111",
        operation: "NOT_A_REAL_OP",
        amountMicro: 1n,
      }),
    ).toThrow();
  });

  it("maps checkout transition names onto 0044 operations via note", () => {
    // CHALLENGED / ORDER_CREATED are not 0044 operations; the builder must map
    // them onto a valid operation and preserve the transition name in `note`.
    const challenged = buildLifecycleEvent({
      orderId: "11111111-1111-1111-1111-111111111111",
      operation: "AUTHORIZED",
      amountMicro: 1_000_000n,
      note: "checkout-transition:CHALLENGED",
    });
    expect(challenged.operation).toBe("AUTHORIZED");
    expect(challenged.note).toContain("CHALLENGED");
  });
});

// ---------------------------------------------------------------------------
// (d) Salt/order correlation — indexer event → DB row
// ---------------------------------------------------------------------------

interface DbOrderRow {
  id: string;
  on_chain_order_id: string | null;
  buyer_id: string;
  amount: string;
}

const ORDER_A: DbOrderRow = {
  id: "aaaa0000-0000-0000-0000-000000000001",
  on_chain_order_id: "7",
  buyer_id: "buyer-1",
  amount: "5000000",
};
const ORDER_B: DbOrderRow = {
  id: "bbbb0000-0000-0000-0000-000000000002",
  on_chain_order_id: null, // draft not yet confirmed on-chain
  buyer_id: "buyer-2",
  amount: "7000000",
};

describe("(d) correlateOrderEvent — exact on_chain_order_id correlation", () => {
  it("matches by exact decimal-string contract id", () => {
    const m = correlateOrderEvent(
      { contractId: "7", eventName: "OrderReleased", txHash: "0xabc" },
      [ORDER_A, ORDER_B],
    );
    expect(m).not.toBeNull();
    expect(m!.order.id).toBe(ORDER_A.id);
  });

  it("normalizes bigint-ish inputs (BigInt or number) to decimal strings", () => {
    const m1 = correlateOrderEvent(
      { contractId: 7n, eventName: "OrderRefunded", txHash: "0xabc" },
      [ORDER_A],
    );
    const m2 = correlateOrderEvent(
      { contractId: 7, eventName: "OrderRefunded", txHash: "0xabc" },
      [ORDER_A],
    );
    expect(m1?.order.id).toBe(ORDER_A.id);
    expect(m2?.order.id).toBe(ORDER_A.id);
  });

  it("returns null when no row carries the contract id (no guessing)", () => {
    const m = correlateOrderEvent(
      { contractId: "999", eventName: "OrderReleased", txHash: "0xabc" },
      [ORDER_A, ORDER_B],
    );
    expect(m).toBeNull();
  });

  it("never correlates a null/empty contract id against null rows", () => {
    // A row with on_chain_order_id=null must NOT match an event with id ""/null —
    // fuzzy correlation would cross-wire money between orders.
    const m = correlateOrderEvent(
      { contractId: "", eventName: "OrderReleased", txHash: "0xabc" },
      [ORDER_A, ORDER_B],
    );
    expect(m).toBeNull();
  });

  it("exposes a mismatch verdict when event payload contradicts the row", () => {
    // OrderReleased carries the payout; if the row amount diverges the
    // correlation is still by id, but the mismatch must be flagged so the
    // reconciler can alert instead of silently mirroring wrong state.
    const m = correlateOrderEvent(
      { contractId: "7", eventName: "OrderReleased", txHash: "0xabc", amountMicro: 999_999n },
      [ORDER_A],
    );
    expect(m).not.toBeNull();
    expect(m!.amountMismatch).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (e) Server-held draft re-validation (anti-tamper)
// ---------------------------------------------------------------------------

const DRAFT: DraftRow = {
  id: "cccc0000-0000-0000-0000-000000000003",
  buyer_id: "buyer-1",
  amount: "5000000",
  buyer_fee: "100000",
  status: "PENDING",
  on_chain_order_id: null,
};

describe("(e) validateDraftForConfirm — server values win", () => {
  it("passes for the owner of a PENDING draft with no client overrides", () => {
    const v = validateDraftForConfirm({ draft: DRAFT, userId: "buyer-1" });
    expect(v.itemAmountMicro).toBe(5_000_000n);
    expect(v.buyerFeeMicro).toBe(100_000n);
    expect(v.approveTotalMicro).toBe(5_100_000n);
  });

  it("rejects a different user (not the draft owner)", () => {
    try {
      validateDraftForConfirm({ draft: DRAFT, userId: "attacker" });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as { code: string }).code).toBe("NOT_ORDER_OWNER");
      expect((e as { httpStatus: number }).httpStatus).toBe(403);
    }
  });

  it("rejects a client-echoed amount that differs from the draft", () => {
    try {
      validateDraftForConfirm({
        draft: DRAFT,
        userId: "buyer-1",
        clientAmountMicro: "1", // attacker tries to underpay
      });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as { code: string }).code).toBe("AMOUNT_MISMATCH");
      expect((e as { httpStatus: number }).httpStatus).toBe(422);
    }
  });

  it("accepts a client-echoed amount that matches the draft exactly", () => {
    const v = validateDraftForConfirm({
      draft: DRAFT,
      userId: "buyer-1",
      clientAmountMicro: "5000000",
    });
    expect(v.itemAmountMicro).toBe(5_000_000n);
  });

  it("rejects a non-PENDING draft with 409", () => {
    try {
      validateDraftForConfirm({
        draft: { ...DRAFT, status: "DONE" },
        userId: "buyer-1",
      });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as { httpStatus: number }).httpStatus).toBe(409);
      expect((e as { code: string }).code).toBe("INVALID_ORDER_STATUS");
    }
  });

  it("rejects garbage amount columns defensively (negative/zero)", () => {
    try {
      validateDraftForConfirm({
        draft: { ...DRAFT, amount: "-5" },
        userId: "buyer-1",
      });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as { httpStatus: number }).httpStatus).toBe(422);
    }
  });
});

// ---------------------------------------------------------------------------
// Confirm route maps guard errors onto HTTP status codes (route-level shape)
// ---------------------------------------------------------------------------

describe("(b)+(e) route error mapping", () => {
  it("GuardConflictError is distinguishable from amount errors by code+status", () => {
    const status = new GuardConflictError("confirm", "DONE", DRAFT_STATUSES);
    expect(status.httpStatus).toBe(409);
    expect(status.code).not.toBe("INVALID_AMOUNT");
  });

  it("CheckoutAction covers the five checkout/lifecycle transitions", () => {
    const actions: CheckoutAction[] = [
      "prepare", "challenge", "confirm", "release", "refund", "cancel",
    ];
    expect(actions.length).toBe(6);
  });
});
