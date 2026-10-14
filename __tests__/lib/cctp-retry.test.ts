import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

/**
 * `retryBridge` is user-triggered and moves money, so the guards matter more
 * than the happy path:
 *   - a user must not be able to retry someone else's bridge
 *   - a bridge with no burn must NOT be reported as retried (nothing happened)
 *   - a retry must never be able to redirect funds — the amount and recipient
 *     live inside Circle's signed message, so all we do is re-submit it
 *   - reaching MINTED must notify the user, because from their side the USDC
 *     simply disappeared from the source chain
 */

// ---- Supabase mock -------------------------------------------------------
interface UpdateCall {
  table: string;
  patch: Record<string, unknown>;
}
let updates: UpdateCall[] = [];
let bridgeRow: Record<string, unknown> | null = null;
let amountRow: { amount_micro: string } | null = null;
let statusRow: { status: string } | null = null;

function makeChain(table: string) {
  let mode: "select" | "update" = "select";
  let cols = "";
  const chain: Record<string, unknown> = {
    select: (c: string) => {
      mode = "select";
      cols = c;
      return chain;
    },
    update: (patch: Record<string, unknown>) => {
      mode = "update";
      updates.push({ table, patch });
      return chain;
    },
    insert: () => chain,
    eq: () => chain,
    in: () => chain,
    not: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => {
      if (mode === "update") return { data: null, error: null };
      if (cols.includes("amount_micro")) return { data: amountRow, error: null };
      if (cols.trim() === "status") return { data: statusRow, error: null };
      return { data: bridgeRow, error: null };
    },
    single: async () => ({ data: bridgeRow, error: null }),
    // Lets `await admin.from(t).update(x).eq(...)` resolve.
    then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
  };
  return chain;
}

vi.mock("@/lib/supabase/admin-client", () => ({
  supabaseAdminClient: () => ({ from: (t: string) => makeChain(t) }),
}));

// ---- Attestation / relay / notify mocks ----------------------------------
const fetchAttestationMock = vi.fn();
const relayMintMock = vi.fn();
const notifyUserMock = vi.fn();

vi.mock("@/lib/cctp/attestation", () => ({
  fetchAttestation: (...a: unknown[]) => fetchAttestationMock(...a),
}));
vi.mock("@/lib/cctp/relay", () => ({
  relayMint: (...a: unknown[]) => relayMintMock(...a),
}));
vi.mock("@/lib/notif", () => ({
  notifyUser: (...a: unknown[]) => notifyUserMock(...a),
}));

import { retryBridge, BridgeError } from "@/lib/cctp/bridge";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const BRIDGE = "33333333-3333-4333-8333-333333333333";
const BURN = "0x" + "ab".repeat(32);

const ORIGINAL_FLAG = process.env.CROSS_CHAIN_PAY;

beforeEach(() => {
  updates = [];
  bridgeRow = null;
  amountRow = { amount_micro: "5000000" };
  statusRow = { status: "MINTED" };
  fetchAttestationMock.mockReset();
  relayMintMock.mockReset();
  notifyUserMock.mockReset();
  process.env.CROSS_CHAIN_PAY = "1";
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.CROSS_CHAIN_PAY;
  else process.env.CROSS_CHAIN_PAY = ORIGINAL_FLAG;
});

describe("retryBridge", () => {
  it("refuses when the feature is off", async () => {
    process.env.CROSS_CHAIN_PAY = "0";
    await expect(retryBridge({ userId: OWNER, bridgeId: BRIDGE })).rejects.toThrow(
      /not enabled/i,
    );
    expect(relayMintMock).not.toHaveBeenCalled();
  });

  it("404s for a bridge that is not the caller's", async () => {
    // The ownership filter is part of the query, so a foreign id simply finds
    // no row. Either way the caller must not learn anything about it.
    bridgeRow = null;
    await expect(retryBridge({ userId: OTHER, bridgeId: BRIDGE })).rejects.toThrow(/not found/i);
    expect(relayMintMock).not.toHaveBeenCalled();
  });

  it("short-circuits when the bridge is already delivered", async () => {
    bridgeRow = { id: BRIDGE, user_id: OWNER, source_chain: "baseSepolia", burn_tx_hash: BURN, status: "MINTED" };

    const res = await retryBridge({ userId: OWNER, bridgeId: BRIDGE });

    expect(res.outcome).toBe("MINTED");
    expect(res.message).toMatch(/already been delivered/i);
    // No second mint attempt, and no duplicate notification.
    expect(fetchAttestationMock).not.toHaveBeenCalled();
    expect(relayMintMock).not.toHaveBeenCalled();
    expect(notifyUserMock).not.toHaveBeenCalled();
  });

  it("409s when nothing was ever burned — retrying would be a no-op that looks like progress", async () => {
    bridgeRow = { id: BRIDGE, user_id: OWNER, source_chain: "baseSepolia", burn_tx_hash: null, status: "FAILED" };

    await expect(retryBridge({ userId: OWNER, bridgeId: BRIDGE })).rejects.toThrow(
      /never reached the burn step/i,
    );
    expect(fetchAttestationMock).not.toHaveBeenCalled();
    expect(relayMintMock).not.toHaveBeenCalled();
  });

  it("reports PENDING while Circle is still attesting, without touching the relay", async () => {
    bridgeRow = { id: BRIDGE, user_id: OWNER, source_chain: "baseSepolia", burn_tx_hash: BURN, status: "BURNED" };
    fetchAttestationMock.mockResolvedValue({ status: "pending" });
    statusRow = { status: "BURNED" };

    const res = await retryBridge({ userId: OWNER, bridgeId: BRIDGE });

    expect(res.outcome).toBe("PENDING");
    expect(res.status).toBe("BURNED");
    expect(res.message).toMatch(/attesting/i);
    expect(relayMintMock).not.toHaveBeenCalled();
    expect(notifyUserMock).not.toHaveBeenCalled();
  });

  it("relays an attested burn, marks MINTED and notifies the user", async () => {
    bridgeRow = { id: BRIDGE, user_id: OWNER, source_chain: "baseSepolia", burn_tx_hash: BURN, status: "BURNED" };
    fetchAttestationMock.mockResolvedValue({
      status: "complete",
      message: "0xdead",
      attestation: "0xbeef",
    });
    relayMintMock.mockResolvedValue({ ok: true, txId: "circle-tx-1", state: "CONFIRMED" });
    statusRow = { status: "MINTED" };

    const res = await retryBridge({ userId: OWNER, bridgeId: BRIDGE });

    expect(res.outcome).toBe("MINTED");
    expect(relayMintMock).toHaveBeenCalledWith({ message: "0xdead", attestation: "0xbeef" });

    const minted = updates.find((u) => u.patch.status === "MINTED");
    expect(minted, "bridge must be persisted as MINTED").toBeTruthy();
    expect(minted!.patch.mint_tx_hash).toBe("circle-tx-1");
    // The earlier ATTESTED write must also have happened, so a crash between the
    // two leaves a resumable state rather than a stuck BURNED row.
    expect(updates.some((u) => u.patch.status === "ATTESTED")).toBe(true);

    expect(notifyUserMock).toHaveBeenCalledTimes(1);
    const [userId, payload] = notifyUserMock.mock.calls[0];
    expect(userId).toBe(OWNER);
    expect(payload.link).toBe("balance");
    expect(payload.email).toBeTruthy();
    // Amount is rendered for the human, not left as atomic units.
    expect(payload.text).toContain("5 USDC");
    expect(payload.text).toContain("Base Sepolia");
  });

  it("treats a retryable relay failure as PENDING and does not notify", async () => {
    bridgeRow = { id: BRIDGE, user_id: OWNER, source_chain: "baseSepolia", burn_tx_hash: BURN, status: "ATTESTED" };
    fetchAttestationMock.mockResolvedValue({ status: "complete", message: "0xdead", attestation: "0xbeef" });
    relayMintMock.mockResolvedValue({ ok: false, reason: "Circle SDK is not configured", retryable: true });
    statusRow = { status: "ATTESTED" };

    const res = await retryBridge({ userId: OWNER, bridgeId: BRIDGE });

    expect(res.outcome).toBe("PENDING");
    expect(notifyUserMock).not.toHaveBeenCalled();
    // Must NOT be marked FAILED — the funds are safe and the attestation lives on.
    expect(updates.some((u) => u.patch.status === "FAILED")).toBe(false);
  });

  it("treats 'already received' as delivered rather than an error", async () => {
    bridgeRow = { id: BRIDGE, user_id: OWNER, source_chain: "baseSepolia", burn_tx_hash: BURN, status: "ATTESTED" };
    fetchAttestationMock.mockResolvedValue({ status: "complete", message: "0xdead", attestation: "0xbeef" });
    relayMintMock.mockResolvedValue({ ok: false, reason: "Message was already received on Arc", retryable: false });
    statusRow = { status: "MINTED" };

    const res = await retryBridge({ userId: OWNER, bridgeId: BRIDGE });

    expect(res.outcome).toBe("MINTED");
    expect(updates.some((u) => u.patch.status === "FAILED")).toBe(false);
    expect(notifyUserMock).toHaveBeenCalledTimes(1);
  });

  it("marks FAILED and explains that nothing is lost when the relay truly fails", async () => {
    bridgeRow = { id: BRIDGE, user_id: OWNER, source_chain: "baseSepolia", burn_tx_hash: BURN, status: "BURNED" };
    fetchAttestationMock.mockResolvedValue({ status: "error", error: "Iris responded 503" });
    statusRow = { status: "FAILED" };

    const res = await retryBridge({ userId: OWNER, bridgeId: BRIDGE });

    expect(res.outcome).toBe("FAILED");
    expect(res.message).toMatch(/nothing is lost/i);
    const failed = updates.find((u) => u.patch.status === "FAILED");
    expect(failed).toBeTruthy();
    expect(String(failed!.patch.error)).toContain("503");
    expect(notifyUserMock).not.toHaveBeenCalled();
  });

  it("surfaces an unknown source chain as a failure instead of throwing", async () => {
    bridgeRow = { id: BRIDGE, user_id: OWNER, source_chain: "notAChain", burn_tx_hash: BURN, status: "BURNED" };
    statusRow = { status: "FAILED" };

    const res = await retryBridge({ userId: OWNER, bridgeId: BRIDGE });

    expect(res.outcome).toBe("FAILED");
    expect(fetchAttestationMock).not.toHaveBeenCalled();
  });

  it("BridgeError carries an HTTP status so the route can respond correctly", async () => {
    bridgeRow = null;
    try {
      await retryBridge({ userId: OWNER, bridgeId: BRIDGE });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(BridgeError);
      expect((e as BridgeError).httpStatus).toBe(404);
    }
  });
});
