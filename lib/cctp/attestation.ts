import { IRIS_API_BASE } from "./chains";

/**
 * Circle's attestation service ("Iris") client.
 *
 * After a CCTP burn, Circle's validators observe the source-chain message and
 * produce a signed attestation. Only then can the message be submitted on Arc
 * with `receiveMessage`. There is no shortcut: the mint is gated on this.
 *
 * Two things this module deliberately does NOT do:
 *
 *  1. **Assume the message is ready.** Standard transfers on the chains we
 *     support take on the order of ~15 minutes to attest (Fast Transfer is not
 *     available on any of them — see `standardOnly` in ./chains). A single
 *     request almost always returns `pending_confirmations`, so the caller must
 *     poll.
 *
 *  2. **Treat any HTTP 200 as success.** Iris answers 200 with an empty
 *     `messages` array for a transaction it has not indexed yet, which looks
 *     identical to "no such transfer". We return an explicit `not_found`
 *     status so a caller cannot mistake "not yet" for "never".
 */

export type AttestationStatus = "pending" | "complete" | "not_found" | "error";

export interface AttestationResult {
  status: AttestationStatus;
  /** The raw CCTP message to submit to `receiveMessage`. Set when complete. */
  message?: `0x${string}`;
  /** Circle's signature over the message. Set when complete. */
  attestation?: `0x${string}`;
  /** Present on `error`; already human-readable. */
  error?: string;
}

/** Iris returns this while validators are still observing the burn. */
const PENDING = "pending_confirmations";
const COMPLETE = "complete";

interface IrisMessage {
  status?: string;
  message?: string;
  attestation?: string;
}

/**
 * One Iris lookup. Never throws — a network failure is an `error` result, so a
 * polling loop can keep going instead of dying on a transient blip.
 */
export async function fetchAttestation(
  sourceDomain: number,
  burnTxHash: string,
  opts: { signal?: AbortSignal } = {},
): Promise<AttestationResult> {
  const url = `${IRIS_API_BASE}/v2/messages/${sourceDomain}?transactionHash=${encodeURIComponent(burnTxHash)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: opts.signal,
      cache: "no-store",
    });
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : "Iris request failed" };
  }

  if (res.status === 404) return { status: "not_found" };
  if (!res.ok) {
    return { status: "error", error: `Iris responded ${res.status}` };
  }

  let body: { messages?: IrisMessage[] };
  try {
    body = (await res.json()) as { messages?: IrisMessage[] };
  } catch {
    return { status: "error", error: "Iris returned a non-JSON body" };
  }

  const msg = body.messages?.[0];
  // 200 + empty means "not indexed yet" — distinct from 404's "unknown transfer",
  // but both are non-terminal, so callers retry either way.
  if (!msg) return { status: "pending" };

  if (msg.status === COMPLETE) {
    if (!msg.message || !msg.attestation) {
      return { status: "error", error: "Iris reported complete but omitted message/attestation" };
    }
    return {
      status: "complete",
      message: msg.message as `0x${string}`,
      attestation: msg.attestation as `0x${string}`,
    };
  }

  if (msg.status === PENDING) return { status: "pending" };

  // Any other status string is unexpected; surface it rather than looping forever.
  return { status: "error", error: `Unexpected Iris status: ${msg.status ?? "(none)"}` };
}

export interface WaitOptions {
  /** Give up after this long. Standard transfers are slow, so the default is generous. */
  timeoutMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
  /** Injected in tests to avoid real sleeping. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests. */
  fetchOnce?: typeof fetchAttestation;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Poll Iris until the attestation is ready, the deadline passes, or an error
 * occurs. Returns the last result either way — the caller decides whether a
 * timeout is worth retrying later (it usually is: the burn is already on-chain
 * and irreversible, so a timeout is never data loss).
 */
export async function waitForAttestation(
  sourceDomain: number,
  burnTxHash: string,
  opts: WaitOptions = {},
): Promise<AttestationResult> {
  const {
    timeoutMs = 25 * 60 * 1000, // 25 min: comfortably above the ~15 min standard transfer
    intervalMs = 20_000,
    signal,
    sleep = defaultSleep,
    fetchOnce = fetchAttestation,
  } = opts;

  const deadline = Date.now() + timeoutMs;
  let last: AttestationResult = { status: "not_found" };

  for (;;) {
    last = await fetchOnce(sourceDomain, burnTxHash, { signal });
    if (last.status === "complete") return last;
    if (last.status === "error") return last;
    if (Date.now() >= deadline) return last;
    await sleep(intervalMs);
  }
}
