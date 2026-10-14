import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock supabase admin client BEFORE importing the module under test.
// `from(table)` returns an object whose `insert(row)` resolves to either
// `{ error: null }` (success) or `{ error: { message } }` (failure).
// The default behavior is: primary `mm_audit_log` FAILS (FK violation),
// `mm_audit_log_failed` SUCCEEDS. Individual tests override via
// `insertResultMock` to simulate the success path.
type InsertResult = { error: { message: string } | null };
const insertResultMock = vi.fn<(table: string, row: unknown) => InsertResult>();

const insertMock = vi.fn();
const fromMock = vi.fn((table: string) => ({
  insert: (row: unknown) => {
    insertMock(table, row);
    const result = insertResultMock(table, row);
    return Promise.resolve(result);
  },
}));

vi.mock("@/lib/supabase/admin-client", () => ({
  supabaseAdminClient: () => ({ from: fromMock }),
}));

import { createMmAuditLog } from "@/lib/mm";

describe("lib/mm — createMmAuditLog", () => {
  beforeEach(() => {
    insertMock.mockClear();
    insertResultMock.mockReset();
    // Default: primary fails (FK violation), dead-letter succeeds.
    insertResultMock.mockImplementation((table) => {
      if (table === "mm_audit_log") {
        return { error: { message: "fk violation: users(id)" } };
      }
      return { error: null };
    });
  });

  it("throws on primary insert failure (does NOT swallow)", async () => {
    await expect(createMmAuditLog({
      mmUserId: null,
      mmWalletId: "platform-wallet",
      actorType: "platform",
      action: "RELEASE_ORDER",
      refId: "order-123",
    })).rejects.toThrow(/mm_audit_log insert failed/);

    // Both primary + dead-letter should have been attempted.
    expect(insertMock).toHaveBeenCalledTimes(2);
    expect(insertMock).toHaveBeenNthCalledWith(1, "mm_audit_log", expect.objectContaining({
      actor_type: "platform",
      action: "RELEASE_ORDER",
      ref_id: "order-123",
    }));
    expect(insertMock).toHaveBeenNthCalledWith(2, "mm_audit_log_failed", expect.objectContaining({
      actor_type: "platform",
      action: "RELEASE_ORDER",
      failure_reason: expect.stringContaining("fk violation"),
    }));
  });

  it("accepts null mmUserId for system actors (primary succeeds)", async () => {
    insertResultMock.mockImplementation(() => ({ error: null }));

    await expect(createMmAuditLog({
      mmUserId: null,
      mmWalletId: "system",
      actorType: "auto_release",
      action: "RELEASE_ORDER",
      refId: "order-456",
      circleTxId: "circle-tx-789",
    })).resolves.toBeUndefined();

    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(insertMock).toHaveBeenCalledWith("mm_audit_log", expect.objectContaining({
      mm_user_id: null,
      actor_type: "auto_release",
      circle_tx_id: "circle-tx-789",
    }));
  });

  it("accepts real user UUID for user actors (primary succeeds)", async () => {
    insertResultMock.mockImplementation(() => ({ error: null }));

    await createMmAuditLog({
      mmUserId: "550e8400-e29b-41d4-a716-446655440000",
      mmWalletId: "treasury",
      actorType: "user",
      action: "TREASURY_WITHDRAW",
      refId: "wtx-123",
    });

    expect(insertMock).toHaveBeenCalledWith("mm_audit_log", expect.objectContaining({
      mm_user_id: "550e8400-e29b-41d4-a716-446655440000",
      actor_type: "user",
    }));
  });
});
