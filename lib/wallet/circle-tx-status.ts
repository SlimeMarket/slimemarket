import { circleDeveloperSdk } from "@/lib/circle/client";

/**
 * Polls Circle until the given tx reaches a terminal state. Bounded by
 * `timeoutMs` so callers can fall back to the reconcile job.
 *
 * Returns the terminal state string (matches Circle's vocabulary):
 *   - "CONFIRMED" | "COMPLETE"  → success
 *   - "FAILED" | "CANCELLED" | "DENIED" → terminal failure
 *   - null → timeout (not mined within budget)
 */
export async function waitForCircleTxState(
  circleTxId: string,
  opts: { timeoutMs?: number } = {}
): Promise<string | null> {
  if (!circleDeveloperSdk) throw new Error("Circle SDK not configured");
  const POLL_INTERVAL_MS = 2000;
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);

  while (Date.now() < deadline) {
    const resp = await circleDeveloperSdk.getTransaction({ id: circleTxId });
    const tx = resp.data?.transaction;
    const state = tx?.state;

    if (state === "CONFIRMED" || state === "COMPLETE") return state;
    if (state === "FAILED" || state === "CANCELLED" || state === "DENIED") return state;

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return null; // timeout
}
