/**
 * Read a Circle W3S transaction's authoritative state.
 *
 * A UCW challenge only tells us that the user approved; the transaction itself
 * can still FAIL afterwards (the common one on Arc is
 * `INSUFFICIENT_NATIVE_TOKEN`, because USDC *is* the gas token). The browser
 * never learns that — Circle's challenge result carries no hash and no error —
 * so the server has to ask Circle directly, or the row stays PENDING forever.
 */
export interface CircleTxState {
  id: string;
  state: string; // INITIATED | PENDING | COMPLETE | FAILED | CANCELLED | DENIED
  txHash: string | null;
  errorReason: string | null;
}

export async function fetchCircleTransaction(txId: string): Promise<CircleTxState | null> {
  const key = process.env.CIRCLE_API_KEY;
  if (!key || !txId) return null;
  try {
    const res = await fetch(`https://api.circle.com/v1/w3s/transactions/${txId}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn(`[circle-tx] lookup ${txId} failed: HTTP ${res.status}`);
      return null;
    }
    const body = (await res.json()) as {
      data?: { transaction?: { id?: string; state?: string; txHash?: string; errorReason?: string } };
    };
    const t = body?.data?.transaction;
    if (!t?.state) return null;
    return {
      id: t.id || txId,
      state: t.state,
      txHash: t.txHash || null,
      errorReason: t.errorReason || null,
    };
  } catch (e) {
    console.warn("[circle-tx] lookup error:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** Terminal failure states for a Circle transaction. */
export function isCircleFailure(state: string): boolean {
  return state === "FAILED" || state === "CANCELLED" || state === "DENIED";
}

/**
 * Turn Circle's enum into something a buyer can act on. The raw reason is kept
 * in the log; the UI gets a sentence that says what to change.
 */
export function explainCircleError(reason: string | null | undefined): string {
  const r = (reason || "").toUpperCase();
  if (r.includes("INSUFFICIENT_NATIVE_TOKEN") || r.includes("INSUFFICIENT_FUNDS")) {
    return "Not enough USDC left to cover the network fee — leave a small buffer and try again";
  }
  if (r.includes("INSUFFICIENT")) return "Insufficient balance for this transfer";
  if (r.includes("BLOCKLIST") || r.includes("DENIED")) return "This transfer was blocked by the provider";
  return reason ? `Transfer failed: ${reason}` : "Transfer failed";
}

/**
 * Poll until the transaction reaches a terminal state, or give up.
 * Short budget on purpose: the browser is waiting on this response. Anything
 * still pending is left to the background reconciler.
 */
export async function waitForCircleTx(
  txId: string,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<CircleTxState | null> {
  const attempts = opts.attempts ?? 6;
  const delayMs = opts.delayMs ?? 1500;
  let last: CircleTxState | null = null;
  for (let i = 0; i < attempts; i++) {
    last = await fetchCircleTransaction(txId);
    if (last && (last.state === "COMPLETE" || isCircleFailure(last.state))) return last;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return last;
}
