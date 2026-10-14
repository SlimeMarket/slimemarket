import { describe, it, expect, vi } from "vitest";

// Silence pino import in lib/order/patterns → lib/logger during tests.
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// admin refund route rebuild (RED phase).

// The old route faked refunds (mock tx hash + nonexistent columns). This file
// tests the rebuilt, real on-chain refund path.
//   1. relay MarketEscrow.refundOrder(onChainId) via Circle DCW FIRST
//   2. only then flip the DB (same transition helper cancel/decline use)
//   3. write a REFUNDED lifecycle row (best-effort)

// processOrderRefund is the pure(ish) extracted core with injected deps so we
// test logic, not network/Supabase.

import {
  processOrderRefund,
  REFUNDABLE_BY_ADMIN_STATUSES,
  type RefundDeps,
} from "@/lib/order/refund";
import type { LifecycleEventInsert } from "@/lib/order/patterns";
import { microToDecimalString } from "@/lib/order/patterns";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeOrder {
  id: string;
  status: string;
  amount: string;
  buyer_id: string;
  on_chain_order_id: string | null;
}

function makeDb(orders: FakeOrder[]) {
  const calls: {
    lifecycleInserts: LifecycleEventInsert[];
    orderUpdates: Array<Record<string, unknown> & { id: string }>;
    rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
    selects: string[];
  } = { lifecycleInserts: [], orderUpdates: [], rpcCalls: [], selects: [] };

  const admin = {
    from(table: string) {
      return {
        select(columns: string) {
          calls.selects.push(`${table}:${columns}`);
          return {
            eq(_col: string, id: string) {
              const found = orders.find((o) => o.id === id) ?? null;
              return {
                maybeSingle: async () => ({ data: found, error: null }),
              };
            },
          };
        },
        insert(row: unknown) {
          calls.lifecycleInserts.push(row as LifecycleEventInsert);
          return Promise.resolve({ error: null });
        },
        update(patch: Record<string, unknown>) {
          return {
            eq(_col: string, id: string) {
              calls.orderUpdates.push({ ...patch, id });
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.rpcCalls.push({ name, args });
      return { data: null, error: null };
    },
  };
  return { admin: admin as unknown as RefundDeps["admin"], calls };
}

function makeDeps(opts?: {
  orders?: FakeOrder[];
  relayResult?: { id: string } | null;
  relayThrows?: Error;
  contractReady?: boolean;
  walletId?: string;
  /** .A — settlement mode; explicit in tests (no reliance on env). */
  nonCustodial?: boolean;
}) {
  const db = makeDb(
    opts?.orders ?? [
      {
        id: "ord-disputed",
        status: "DISPUTED",
        amount: "10000000",
        buyer_id: "buyer-1",
        on_chain_order_id: "42",
      },
    ],
  );
  const refundOrderOnChain = vi.fn(async (_onChainId: string, _walletId: string) => {
    if (opts?.relayThrows) throw opts.relayThrows;
    return opts?.relayResult === undefined ? { id: "ctx-123", state: "INITIATED" } : opts.relayResult;
  });
  const deps: RefundDeps = {
    admin: db.admin,
    isContractReady: () => opts?.contractReady ?? true,
    refundOrderOnChain,
    recordLifecycleEvent: async (admin, input) => {
      // Mirror the real write: insert a row into lifecycle_events.
      await (admin as ReturnType<typeof makeDb>["admin"]).from("lifecycle_events").insert({
        order_id: input.orderId,
        operation: input.operation,
        tx_hash: input.txHash ?? null,
        amount:
          input.amountMicro != null ? microToDecimalString(input.amountMicro) : null,
        note: input.note ?? null,
      } as unknown as Record<string, unknown>);
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    platformWalletId: opts?.walletId ?? "wallet-platform",
    nonCustodial: opts?.nonCustodial ?? false,
  };
  return { deps, calls: db.calls, refundOrderOnChain };
}

const ADMIN = {
  id: "admin-1",
  role: "Admin",
  name: "Admin",
  email: "a@x.co",
} as unknown as Pick<import("@/lib/auth-ucw").CurrentUser, "id" | "role">;

// ---------------------------------------------------------------------------
// Status set — derived from the DB CHECK + dispute resolve semantics
// ---------------------------------------------------------------------------

describe("REFUNDABLE_BY_ADMIN_STATUSES", () => {
  it("is exactly DISPUTED (the only status where funds are escrowed and no buyer/seller path exists)", () => {
    expect(REFUNDABLE_BY_ADMIN_STATUSES).toEqual(["DISPUTED"]);
  });
});

// ---------------------------------------------------------------------------
// 404 / 409 guards
// ---------------------------------------------------------------------------

describe("processOrderRefund — guards", () => {
  it("order not found → error with httpStatus 404", async () => {
    const { deps, refundOrderOnChain } = makeDeps({ orders: [] });
    await expect(
      processOrderRefund(deps, { orderId: "missing", reason: "x" }, ADMIN),
    ).rejects.toMatchObject({ httpStatus: 404 });
    expect(refundOrderOnChain).not.toHaveBeenCalled();
  });

  it("non-refundable statuses → 409, no relay, no DB mutation", async () => {
    for (const status of ["PENDING", "PROCESS", "SENT", "DONE", "CANCELLED", "DECLINED"]) {
      const { deps, calls, refundOrderOnChain } = makeDeps({
        orders: [
          { id: "o1", status, amount: "100", buyer_id: "b", on_chain_order_id: "42" },
        ],
      });
      await expect(
        processOrderRefund(deps, { orderId: "o1", reason: "x" }, ADMIN),
      ).rejects.toMatchObject({ httpStatus: 409, code: "INVALID_ORDER_STATUS" });
      expect(refundOrderOnChain).not.toHaveBeenCalled();
      expect(calls.orderUpdates).toHaveLength(0);
      expect(calls.lifecycleInserts).toHaveLength(0);
    }
  });

  it("terminal refund states (CANCELLED/DECLINED = already refunded) → 409 idempotent reject", async () => {
    // CANCELLED/DECLINED orders already had the ledger refund via
    // cancel/decline/resolve atomics — refunding again would double-move funds.
    const { deps, refundOrderOnChain } = makeDeps({
      orders: [{ id: "o1", status: "CANCELLED", amount: "100", buyer_id: "b", on_chain_order_id: "42" }],
    });
    await expect(
      processOrderRefund(deps, { orderId: "o1", reason: "x" }, ADMIN),
    ).rejects.toMatchObject({ httpStatus: 409 });
    expect(refundOrderOnChain).not.toHaveBeenCalled();
  });

  it("on_chain_order_id missing (contract order never created / not on-chain) → 501, no relay", async () => {
    const { deps, calls, refundOrderOnChain } = makeDeps({
      orders: [{ id: "o1", status: "DISPUTED", amount: "100", buyer_id: "b", on_chain_order_id: null }],
    });
    await expect(
      processOrderRefund(deps, { orderId: "o1", reason: "x" }, ADMIN),
    ).rejects.toMatchObject({ httpStatus: 501, code: "NO_ONCHAIN_REFUND_PATH" });
    expect(refundOrderOnChain).not.toHaveBeenCalled();
    expect(calls.orderUpdates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Funds-first: relay failure must never touch the DB status
// ---------------------------------------------------------------------------

describe("processOrderRefund — funds-first relay failure", () => {
  it("contract not ready → 502-ish error, DB untouched", async () => {
    const { deps, calls, refundOrderOnChain } = makeDeps({ contractReady: false });
    await expect(
      processOrderRefund(deps, { orderId: "ord-disputed", reason: "x" }, ADMIN),
    ).rejects.toMatchObject({ httpStatus: 503, code: "ESCROW_UNAVAILABLE" });
    expect(refundOrderOnChain).not.toHaveBeenCalled();
    expect(calls.orderUpdates).toHaveLength(0);
    expect(calls.rpcCalls).toHaveLength(0);
    expect(calls.lifecycleInserts).toHaveLength(0);
  });

  it("relay throws → 502, DB status NOT updated (no refund claim without chain submission)", async () => {
    const { deps, calls, refundOrderOnChain } = makeDeps({
      relayThrows: new Error("circle relay down"),
    });
    await expect(
      processOrderRefund(deps, { orderId: "ord-disputed", reason: "x" }, ADMIN),
    ).rejects.toMatchObject({ httpStatus: 502, code: "REFUND_RELAY_FAILED" });
    expect(refundOrderOnChain).toHaveBeenCalledTimes(1);
    expect(refundOrderOnChain).toHaveBeenCalledWith("42", "wallet-platform");
    expect(calls.rpcCalls).toHaveLength(0);
    expect(calls.orderUpdates).toHaveLength(0);
    expect(calls.lifecycleInserts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("processOrderRefund — happy path", () => {
  it("relay succeeds → DB transition, REFUNDED lifecycle row, returns status + txId", async () => {
    const { deps, calls, refundOrderOnChain } = makeDeps();
    const result = await processOrderRefund(
      deps,
      { orderId: "ord-disputed", reason: "buyer right" },
      ADMIN,
    );

    // Funds first: relay called exactly once with the on-chain id + platform DCW.
    expect(refundOrderOnChain).toHaveBeenCalledTimes(1);
    expect(refundOrderOnChain).toHaveBeenCalledWith("42", "wallet-platform");

    // Then the SAME atomic transition the dispute resolve path uses.
    expect(calls.rpcCalls).toHaveLength(1);
    expect(calls.rpcCalls[0].name).toBe("resolve_dispute_atomic");
    expect(calls.rpcCalls[0].args).toMatchObject({
      p_order_id: "ord-disputed",
      p_actor_id: "admin-1",
      p_decision: "refund",
      p_reason: "buyer right",
    });

    // on_chain_status mirror update happens only after relay accepted.
    expect(calls.orderUpdates.some((u) => u.on_chain_status === "refund_pending")).toBe(true);

    // REFUNDED lifecycle event written (best-effort, real shape).
    expect(calls.lifecycleInserts).toHaveLength(1);
    const ev = calls.lifecycleInserts[0];
    expect(ev.order_id).toBe("ord-disputed");
    expect(ev.operation).toBe("REFUNDED");
    expect(ev.tx_hash).toBe("ctx-123");
    expect(ev.amount).toBe("10.000000"); // 10000000 micro-USDC → decimal(20,6)
    expect(ev.note).toContain("admin-refund");

    expect(result).toMatchObject({
      status: "CANCELLED", // resolve_dispute_atomic refund → CANCELLED
      txId: "ctx-123",
      onChainOrderId: "42",
    });
  });

  it("relay accepted but returns null id → still proceeds with txId null", async () => {
    const { deps, calls } = makeDeps({ relayResult: null });
    const result = await processOrderRefund(
      deps,
      { orderId: "ord-disputed", reason: "x" },
      ADMIN,
    );
    expect(calls.rpcCalls).toHaveLength(1);
    expect(result.txId).toBeNull();
    expect(result.status).toBe("CANCELLED");
  });
});

// ---------------------------------------------------------------------------
// Idempotency — second call on an already-refunded order never relays again
// ---------------------------------------------------------------------------

describe("processOrderRefund — idempotency", () => {
  it("second call on now-CANCELLED order → 409, zero additional relays", async () => {
    const order: FakeOrder = {
      id: "o1",
      status: "DISPUTED",
      amount: "5000000",
      buyer_id: "b",
      on_chain_order_id: "7",
    };
    const db = makeDb([order]);
    const refundOrderOnChain = vi.fn(async () => ({ id: "ctx-9", state: "INITIATED" }));
    const deps: RefundDeps = {
      admin: db.admin,
      isContractReady: () => true,
      refundOrderOnChain,
      recordLifecycleEvent: async () => {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      platformWalletId: "wallet-platform",
    };

    const first = await processOrderRefund(deps, { orderId: "o1", reason: "x" }, ADMIN);
    expect(first.status).toBe("CANCELLED");

    // Simulate the atomic having flipped the status (what the DB would show).
    order.status = "CANCELLED";

    await expect(
      processOrderRefund(deps, { orderId: "o1", reason: "x" }, ADMIN),
    ).rejects.toMatchObject({ httpStatus: 409 });
    expect(refundOrderOnChain).toHaveBeenCalledTimes(1); // no double relay
  });
});

// ---------------------------------------------------------------------------
// .A — settlement RPC mode selection: non-custodial must NEVER run the
// ledger-crediting variant (double-book), custodial legacy keeps it.
// ---------------------------------------------------------------------------

describe("processOrderRefund — settlement RPC mode (.A)", () => {
  it("non-custodial → calls resolve_dispute_noncustodial (no ledger credit)", async () => {
    const { deps, calls } = makeDeps({ nonCustodial: true });
    await processOrderRefund(deps, { orderId: "ord-disputed", reason: "x" }, ADMIN);
    expect(calls.rpcCalls).toHaveLength(1);
    expect(calls.rpcCalls[0].name).toBe("resolve_dispute_noncustodial");
    expect(calls.rpcCalls[0].args).toMatchObject({ p_decision: "refund" });
  });

  it("custodial legacy → still calls resolve_dispute_atomic", async () => {
    const { deps, calls } = makeDeps({ nonCustodial: false });
    await processOrderRefund(deps, { orderId: "ord-disputed", reason: "x" }, ADMIN);
    expect(calls.rpcCalls[0].name).toBe("resolve_dispute_atomic");
  });
});
