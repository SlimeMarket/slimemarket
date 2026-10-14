import { circleDeveloperSdk } from "@/lib/circle/client";
import { ARC_CCTP, IRIS_API_BASE } from "./chains";

/**
 * Completes a CCTP transfer on Arc by submitting the attested message.
 *
 * WHY WE DO THIS OURSELVES: CCTP's Forwarding Service would let Circle's relayer
 * perform the mint, but it is unavailable on this route —
 * `cctp.forwarderSupported.source` is `false` for every source chain we support
 * (verified from `@circle-fin/provider-cctp-v2`), and forwarding is a
 * source-side capability. So the mint is on us.
 *
 * WHY THAT IS SAFE: `receiveMessage` is PERMISSIONLESS. Anyone holding a valid
 * attestation can submit it, and the funds can only ever be minted to the
 * `mintRecipient` baked into the signed message — which is the user's own Arc
 * address. The relayer cannot redirect the money, and cannot mint without
 * Circle's signature. If our relayer is down or the platform is compromised, the
 * user (or anyone) can still call `receiveMessage` on Arc directly with the same
 * attestation. So this is a convenience step, not a custody step.
 *
 * Note we deliberately do NOT use `PLATFORM_CIRCLE_WALLET_ID`'s authority for
 * anything else here — the only thing this transaction can do is deliver USDC
 * that the user already burned, to the address they already chose.
 */

/** MessageTransmitterV2.receiveMessage(bytes message, bytes attestation) */
const RECEIVE_MESSAGE_SIGNATURE = "receiveMessage(bytes,bytes)";

export interface RelayResult {
  ok: boolean;
  /** Circle's transaction id, when the call was accepted. */
  txId?: string;
  /** Circle's terminal state (CONFIRMED / FAILED / …), when known. */
  state?: string;
  /** Human-readable reason when `ok` is false. */
  reason?: string;
  /** True when the failure is worth retrying later (the burn is not lost). */
  retryable?: boolean;
}

function relayerWalletId(): string {
  const id = process.env.PLATFORM_CIRCLE_WALLET_ID ?? "";
  if (!id) {
    throw new Error("PLATFORM_CIRCLE_WALLET_ID is not set — no wallet to relay the mint from");
  }
  return id;
}

/**
 * Submit `receiveMessage` on Arc.
 *
 * Errors are classified: a transient problem (Circle down, tx still pending) is
 * `retryable`, because the burn already happened and the attestation does not
 * expire — the user's money is safe and a later retry will still deliver it. A
 * permanent problem (already received, malformed message) is not.
 */
export async function relayMint(params: {
  message: `0x${string}`;
  attestation: `0x${string}`;
}): Promise<RelayResult> {
  const { message, attestation } = params;

  if (!message?.startsWith("0x") || message.length < 3) {
    return { ok: false, reason: "CCTP message is missing or malformed" };
  }
  if (!attestation?.startsWith("0x") || attestation.length < 3) {
    return { ok: false, reason: "CCTP attestation is missing or malformed" };
  }
  if (!circleDeveloperSdk) {
    return { ok: false, reason: "Circle SDK is not configured", retryable: true };
  }

  let walletId: string;
  try {
    walletId = relayerWalletId();
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "relayer not configured" };
  }

  try {
    const resp = await circleDeveloperSdk.createContractExecutionTransaction({
      walletId,
      contractAddress: ARC_CCTP.messageTransmitter,
      abiFunctionSignature: RECEIVE_MESSAGE_SIGNATURE,
      abiParameters: [message, attestation],
      // The mint is the last hop and the user is waiting on it, so pay up for
      // inclusion rather than saving fractions of a cent.
      fee: { type: "level", config: { feeLevel: "HIGH" } },
    } as unknown as Parameters<typeof circleDeveloperSdk.createContractExecutionTransaction>[0]);

    const data = resp.data as { id?: string; state?: string } | undefined;
    if (!data?.id) {
      return { ok: false, reason: "Circle did not return a transaction id", retryable: true };
    }
    return { ok: true, txId: data.id, state: data.state ?? "UNKNOWN" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "relay failed";
    // "already received" means someone (possibly a previous attempt of ours)
    // completed the mint. That is success from the user's point of view, and
    // retrying forever would just log noise.
    if (/already\s*(been\s*)?(received|used)/i.test(msg)) {
      return { ok: false, reason: "Message was already received on Arc", retryable: false };
    }
    return { ok: false, reason: msg, retryable: true };
  }
}

/**
 * Poll Circle until the relay transaction reaches a terminal state.
 *
 * Bounded, because the caller is a request handler or a cron tick — an unbounded
 * wait here would hold a connection open for minutes. A timeout is not a
 * failure: the transaction is already submitted and will land on its own.
 */
export async function waitForRelayTx(
  txId: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<{ state: string; txHash?: string }> {
  const { timeoutMs = 90_000, intervalMs = 3_000 } = opts;
  const deadline = Date.now() + timeoutMs;
  let lastState = "UNKNOWN";

  if (!circleDeveloperSdk) return { state: lastState };

  for (;;) {
    try {
      const resp = await circleDeveloperSdk.getTransaction({ id: txId });
      const tx = resp.data?.transaction as { state?: string; txHash?: string } | undefined;
      lastState = tx?.state ?? lastState;
      if (lastState === "CONFIRMED" || lastState === "FAILED" || lastState === "CANCELLED") {
        return { state: lastState, txHash: tx?.txHash };
      }
    } catch {
      // Transient read failure — keep polling until the deadline.
    }
    if (Date.now() >= deadline) return { state: lastState };
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
}

/** Exposed for ops/diagnostics: which Iris host and Arc contract this build uses. */
export function relayConfig() {
  return {
    iris: IRIS_API_BASE,
    arcDomain: ARC_CCTP.domain,
    messageTransmitter: ARC_CCTP.messageTransmitter,
    relayerConfigured: Boolean(process.env.PLATFORM_CIRCLE_WALLET_ID),
  };
}
