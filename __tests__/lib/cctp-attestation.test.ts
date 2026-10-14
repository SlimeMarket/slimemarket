import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchAttestation, waitForAttestation } from "@/lib/cctp/attestation";

/**
 * Iris is the gate between a burn and a mint: no attestation, no mint. The
 * failure modes that matter are all about NOT mistaking "not yet" for "never",
 * because that would mark a perfectly good bridge as failed while the user's
 * USDC is already burned.
 */

// Importing the module graph (viem + chains) has been observed at ~25s cold,
// well past vitest's 5s default.
vi.setConfig({ testTimeout: 60_000 });

const realFetch = globalThis.fetch;

function jsonOnce(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response);
}

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

beforeEach(() => {
  globalThis.fetch = realFetch;
});

describe("fetchAttestation", () => {
  it("returns complete with message + attestation", async () => {
    globalThis.fetch = jsonOnce(200, {
      messages: [{ status: "complete", message: "0xdeadbeef", attestation: "0xsig" }],
    }) as unknown as typeof fetch;

    const res = await fetchAttestation(6, "0xabc");
    expect(res.status).toBe("complete");
    expect(res.message).toBe("0xdeadbeef");
    expect(res.attestation).toBe("0xsig");
  });

  it("maps pending_confirmations to pending", async () => {
    globalThis.fetch = jsonOnce(200, {
      messages: [{ status: "pending_confirmations" }],
    }) as unknown as typeof fetch;

    await expect(fetchAttestation(6, "0xabc")).resolves.toEqual({ status: "pending" });
  });

  it("treats 200 with an EMPTY messages array as pending, not not_found", async () => {
    // Iris answers 200 + [] for a tx it has not indexed yet. Reading that as
    // "unknown transfer" would fail a bridge that is actually fine.
    globalThis.fetch = jsonOnce(200, { messages: [] }) as unknown as typeof fetch;

    await expect(fetchAttestation(6, "0xabc")).resolves.toEqual({ status: "pending" });
  });

  it("maps HTTP 404 to not_found", async () => {
    globalThis.fetch = jsonOnce(404, {}) as unknown as typeof fetch;
    await expect(fetchAttestation(6, "0xabc")).resolves.toEqual({ status: "not_found" });
  });

  it("maps a 5xx to error with the status in the message", async () => {
    globalThis.fetch = jsonOnce(503, {}) as unknown as typeof fetch;
    const res = await fetchAttestation(6, "0xabc");
    expect(res.status).toBe("error");
    expect(res.error).toMatch(/503/);
  });

  it("flags 'complete' without payload as an error rather than a silent success", async () => {
    globalThis.fetch = jsonOnce(200, {
      messages: [{ status: "complete" }],
    }) as unknown as typeof fetch;

    const res = await fetchAttestation(6, "0xabc");
    expect(res.status).toBe("error");
    expect(res.error).toMatch(/omitted/i);
  });

  it("surfaces an unexpected status string instead of looping forever", async () => {
    globalThis.fetch = jsonOnce(200, {
      messages: [{ status: "something_new" }],
    }) as unknown as typeof fetch;

    const res = await fetchAttestation(6, "0xabc");
    expect(res.status).toBe("error");
    expect(res.error).toMatch(/something_new/);
  });

  it("never throws on a network failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNRESET")) as unknown as typeof fetch;

    const res = await fetchAttestation(6, "0xabc");
    expect(res.status).toBe("error");
    expect(res.error).toMatch(/ECONNRESET/);
  });

  it("never throws on a non-JSON body", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response) as unknown as typeof fetch;

    const res = await fetchAttestation(6, "0xabc");
    expect(res.status).toBe("error");
    expect(res.error).toMatch(/non-JSON/);
  });

  it("requests the sandbox host for the active (testnet) network", async () => {
    const spy = jsonOnce(200, { messages: [] });
    globalThis.fetch = spy as unknown as typeof fetch;

    await fetchAttestation(6, "0xabc");
    const url = String(spy.mock.calls[0][0]);
    expect(url).toContain("iris-api-sandbox.circle.com");
    expect(url).toContain("/v2/messages/6");
    expect(url).toContain("transactionHash=0xabc");
  });
});

describe("waitForAttestation", () => {
  const noSleep = async () => {};

  it("returns as soon as the attestation is complete", async () => {
    const fetchOnce = vi
      .fn()
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValueOnce({ status: "complete", message: "0xm", attestation: "0xs" });

    const res = await waitForAttestation(6, "0xabc", { sleep: noSleep, fetchOnce: fetchOnce as never });
    expect(res.status).toBe("complete");
    // Polled once (pending), then stopped — it must not keep hammering Iris.
    expect(fetchOnce).toHaveBeenCalledTimes(2);
  });

  it("stops immediately on an error instead of retrying blindly", async () => {
    const fetchOnce = vi.fn().mockResolvedValue({ status: "error", error: "boom" });
    const res = await waitForAttestation(6, "0xabc", { sleep: noSleep, fetchOnce: fetchOnce as never });
    expect(res.status).toBe("error");
    expect(fetchOnce).toHaveBeenCalledTimes(1);
  });

  it("gives up at the deadline and reports the last state (pending, not failed)", async () => {
    const fetchOnce = vi.fn().mockResolvedValue({ status: "pending" });
    const res = await waitForAttestation(6, "0xabc", {
      timeoutMs: 0,
      sleep: noSleep,
      fetchOnce: fetchOnce as never,
    });
    // A timeout is NOT a failure: the burn is already on-chain and irreversible.
    expect(res.status).toBe("pending");
  });

  it("treats not_found as non-terminal and keeps polling", async () => {
    const fetchOnce = vi
      .fn()
      .mockResolvedValueOnce({ status: "not_found" })
      .mockResolvedValueOnce({ status: "complete", message: "0xm", attestation: "0xs" });

    const res = await waitForAttestation(6, "0xabc", { sleep: noSleep, fetchOnce: fetchOnce as never });
    expect(res.status).toBe("complete");
    expect(fetchOnce).toHaveBeenCalledTimes(2);
  });
});
