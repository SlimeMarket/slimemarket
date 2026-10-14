import { parseEventLogs, type Hex } from "viem";
import { arcPublicClient } from "@/lib/arc";
import { circleDeveloperSdk } from "@/lib/circle/client";
import { ESCROW_CREATION_ABI } from "@/lib/contracts/escrow-events";

/**
 * Resolves the REAL on-chain identifiers emitted by MarketEscrow, so the DB can
 * store the contract `orderId`/`dealId` (a uint) instead of the Circle tx id.
 *
 * Flow (checkout/deal confirm):
 *   1. Relay createOrderFor(...) via Circle DCW → returns a Circle *tx id*.
 *   2. waitForCircleTxHash(circleTxId) → poll Circle until the tx is mined,
 *      returning the on-chain tx hash.
 *   3. resolveOrderIdFromTxHash(txHash) → read the receipt, parse the
 *      `OrderCreated` event, return `id`.
 *
 * Why not a pure background indexer? OrderCreated does not carry the DB order id,
 * so we cannot correlate event→row from logs alone. Because WE submit the tx for
 * a known order, resolving inline from that tx's receipt is unambiguous. The
 * background indexer (see indexer.ts) is for reconciliation of later lifecycle
 * events (Released/Refunded/FeesCollected), not initial correlation.
 */

/**
 * Event ABI for decoding creation events out of a tx receipt.
 *
 * ⚠️ This array used to be hand-written here and was WRONG — `OrderCreated` was
 * declared with 4 arguments while the contract emits 5 (there is a `fee`).
 * Because `parseEventLogs` matches logs by topic0 (the keccak of the signature),
 * a wrong ABI made EVERY OrderCreated log be skipped without an error, `orderId`
 * was always `null`, and `on_chain_order_id` was never populated. It is now
 * imported from the generated file so it cannot drift again.
 */
const CREATION_EVENTS_ABI = ESCROW_CREATION_ABI;

const POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 90_000;

/**
 * Polls Circle until the given contract-execution tx reaches a terminal mined
 * state and exposes its on-chain hash. Bounded by `timeoutMs` (unlike the
 * gateway-sdk helper's infinite loop) so callers can fall back to the indexer.
 */
export async function waitForCircleTxHash(
  circleTxId: string,
  opts: { timeoutMs?: number } = {}
): Promise<Hex | null> {
  if (!circleDeveloperSdk) throw new Error("Circle SDK not configured");
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  while (Date.now() < deadline) {
    const resp = await circleDeveloperSdk.getTransaction({ id: circleTxId });
    const tx = resp.data?.transaction;
    const state = tx?.state;

    if (state === "CONFIRMED" || state === "COMPLETE") {
      return (tx?.txHash as Hex | undefined) ?? null;
    }
    if (state === "FAILED" || state === "CANCELLED" || state === "DENIED") {
      throw new Error(
        `Circle tx ${circleTxId} terminal-failed: ${state}${tx?.errorReason ? ` (${tx.errorReason})` : ""}`
      );
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  // Not mined within budget — caller should rely on the reconciliation indexer.
  return null;
}

/** Reads a tx receipt and returns the `OrderCreated.id` as a decimal string. */
export async function resolveOrderIdFromTxHash(txHash: Hex): Promise<string | null> {
  const receipt = await arcPublicClient().getTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`tx ${txHash} reverted on-chain`);
  }
  const logs = parseEventLogs({
    abi: CREATION_EVENTS_ABI,
    eventName: "OrderCreated",
    logs: receipt.logs,
  });
  const id = logs[0]?.args?.id;
  return id !== undefined ? id.toString() : null;
}

/** Reads a tx receipt and returns the `DealCreated.id` as a decimal string. */
export async function resolveDealIdFromTxHash(txHash: Hex): Promise<string | null> {
  const receipt = await arcPublicClient().getTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`tx ${txHash} reverted on-chain`);
  }
  const logs = parseEventLogs({
    abi: CREATION_EVENTS_ABI,
    eventName: "DealCreated",
    logs: receipt.logs,
  });
  const id = logs[0]?.args?.id;
  return id !== undefined ? id.toString() : null;
}

/**
 * Convenience: given the Circle tx id returned by a relayed createOrderFor, wait
 * for it to mine and return the contract orderId. Returns null if not mined in
 * time (reconciliation indexer will backfill).
 */
export async function resolveOrderIdFromCircleTx(
  circleTxId: string,
  opts: { timeoutMs?: number } = {}
): Promise<{ orderId: string | null; txHash: Hex | null }> {
  const txHash = await waitForCircleTxHash(circleTxId, opts);
  if (!txHash) return { orderId: null, txHash: null };
  const orderId = await resolveOrderIdFromTxHash(txHash);
  return { orderId, txHash };
}

/** Same as above for WL deals (DealCreated). */
export async function resolveDealIdFromCircleTx(
  circleTxId: string,
  opts: { timeoutMs?: number } = {}
): Promise<{ dealId: string | null; txHash: Hex | null }> {
  const txHash = await waitForCircleTxHash(circleTxId, opts);
  if (!txHash) return { dealId: null, txHash: null };
  const dealId = await resolveDealIdFromTxHash(txHash);
  return { dealId, txHash };
}
