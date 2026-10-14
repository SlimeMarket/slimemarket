import { parseEventLogs, type Hex, type Log } from "viem";
import { arcPublicClient } from "@/lib/arc";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { ESCROW_LIFECYCLE_ABI } from "@/lib/contracts/escrow-events";

/**
 * MarketEscrow reconciliation indexer (see docs/ONCHAIN_ESCROW_PLAN.md §9).
 *
 * Watches escrow *lifecycle* events and mirrors them into the DB so order/deal
 * status eventually reflects the chain even if an inline call missed the
 * confirmation. Resumable via the `indexer_state` table (last_processed_block).
 *
 * NOT responsible for initial event→row correlation on creation — that is done
 * inline from the submitting tx's receipt (see resolver.ts), because Created
 * events don't carry the DB id. Here we map by the contract id already stored
 * on the row (`on_chain_order_id` / `on_chain_deal_id`).
 *
 * Runner-agnostic: call `runIndexerOnce()` from a cron route or a worker loop.
 */

const STREAM_ID = "market_escrow";
const ESCROW_CONTRACT_ADDRESS = (process.env.ESCROW_CONTRACT_ADDRESS ?? "") as Hex;
/** Cap blocks scanned per run to stay under RPC getLogs range limits. */
const MAX_BLOCK_SPAN = BigInt(process.env.INDEXER_MAX_BLOCK_SPAN ?? "2000");
/** Confirmations to wait before treating a block as final (Arc: 1 = deterministic). */
const CONFIRMATIONS = BigInt(process.env.INDEXER_CONFIRMATIONS ?? "1");

/**
 * Event ABI for the lifecycle events. Imported from the generated file.
 *
 * ⚠️ This array used to be hand-written here and declared `OrderReleased` with
 * 5 arguments (id, mm, seller, payout, fee), while the contract only emits 4
 * (no `fee`). Because `parseEventLogs` matches logs by topic0 (the keccak of the
 * signature), `OrderReleased` was NEVER decoded → `markOrder(..., "RELEASED")`
 * never ran, so an order already released on-chain still looked unreleased in
 * the DB.
 * (The 5th argument name on `DealReleased` was wrong too — it should be
 * `collateralReturned` rather than `fee` — but that one is cosmetic; the arity
 * was already correct.)
 */
const LIFECYCLE_ABI = ESCROW_LIFECYCLE_ABI;

export interface IndexerRunResult {
  ran: boolean;
  fromBlock?: string;
  toBlock?: string;
  processed?: number;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Pattern (d) — salt/order correlation verification.
// The indexer mirrors chain→DB. Correlation is EXACT: an event applies to a
// DB row if and only if the row's stored contract id (on_chain_order_id /
// on_chain_deal_id) equals the event's contract id as decimal strings. No
// fuzzy matching — cross-wiring money between orders is worse than a missed
// mirror (the reconcile queue backstops misses).
// ---------------------------------------------------------------------------

/** Minimal shape of a DB row the indexer can correlate against. */
export interface CorrelatableRow {
  id: string;
  on_chain_order_id: string | null;
  /** Present in micro-USDC on order rows; optional here. */
  amount?: string;
  buyer_id?: string;
}

export interface OrderEventLike {
  /** Contract order id from the tx event (uint256). bigint | number | string. */
  contractId: string | bigint | number;
  eventName: string;
  txHash: string;
  /** If the event carries an amount (e.g. OrderReleased.payout) in micro-USDC. */
  amountMicro?: bigint;
}

export interface CorrelationMatch {
  order: CorrelatableRow;
  /** Decimal-string contract id used for the exact match. */
  contractId: string;
  /**
   * True when the event's amount contradicts the row's amount. The match is
   * still by id (authoritative), but the flag lets the caller alert instead
   * of silently mirroring divergent state.
   */
  amountMismatch: boolean;
}

/** Normalize any event id representation to a decimal string. */
export function normalizeContractId(id: string | bigint | number): string {
  return typeof id === "string" ? id.trim() : id.toString();
}

/**
 * Pure, unit-testable correlation: find the DB row whose on_chain_order_id
 * exactly equals the event's contract id. Returns null when nothing matches
 * (NEVER guesses) and flags amount mismatches when both sides carry an amount.
 */
export function correlateOrderEvent(
  event: OrderEventLike,
  dbOrders: readonly CorrelatableRow[],
): CorrelationMatch | null {
  const contractId = normalizeContractId(event.contractId);
  if (!contractId) return null; // empty id must never match anything
  const order = dbOrders.find((r) => r.on_chain_order_id === contractId);
  if (!order) return null;

  let amountMismatch = false;
  if (event.amountMicro !== undefined && typeof order.amount === "string" && order.amount) {
    try {
      amountMismatch = BigInt(order.amount) !== event.amountMicro;
    } catch {
      amountMismatch = true; // unparseable row amount vs event amount → flag it
    }
  }

  return { order, contractId, amountMismatch };
}

function isReady(): boolean {
  return !!ESCROW_CONTRACT_ADDRESS;
}

/** Reads the resume cursor; seeds it lazily at (head - MAX_BLOCK_SPAN) on first run. */
async function getFromBlock(
  admin: ReturnType<typeof supabaseAdminClient>,
  head: bigint
): Promise<bigint> {
  const { data } = await admin
    .from("indexer_state")
    .select("last_processed_block")
    .eq("id", STREAM_ID)
    .maybeSingle();

  const stored = data?.last_processed_block;
  if (stored === undefined || stored === null) {
    const seed =
      process.env.ESCROW_START_BLOCK !== undefined
        ? BigInt(process.env.ESCROW_START_BLOCK)
        : head > MAX_BLOCK_SPAN
          ? head - MAX_BLOCK_SPAN
          : 0n;
    await admin.from("indexer_state").upsert({
      id: STREAM_ID,
      contract_address: ESCROW_CONTRACT_ADDRESS,
      last_processed_block: Number(seed),
      updated_at: new Date().toISOString(),
    });
    return seed;
  }
  // Resume from the block AFTER the last processed one.
  return BigInt(stored) + 1n;
}

async function setLastProcessedBlock(
  admin: ReturnType<typeof supabaseAdminClient>,
  block: bigint
): Promise<void> {
  await admin.from("indexer_state").upsert({
    id: STREAM_ID,
    contract_address: ESCROW_CONTRACT_ADDRESS,
    last_processed_block: Number(block),
    updated_at: new Date().toISOString(),
  });
}

/** Idempotently mark an order row (matched by contract id) with a final on-chain status. */
async function markOrder(
  admin: ReturnType<typeof supabaseAdminClient>,
  contractId: string,
  status: "RELEASED" | "REFUNDED",
  txHash: string
): Promise<void> {
  await admin
    .from("orders")
    .update({ on_chain_status: status, on_chain_tx_hash: txHash })
    .eq("on_chain_order_id", contractId);
}

async function markDeal(
  admin: ReturnType<typeof supabaseAdminClient>,
  contractId: string,
  status: "RELEASED" | "REFUNDED",
  txHash: string
): Promise<void> {
  await admin
    .from("wl_deals")
    .update({ on_chain_status: status, on_chain_tx_hash: txHash })
    .eq("on_chain_deal_id", contractId);

  // also mirror the TERMINAL on-chain outcome into the deal's MAIN
  // status, but only when nothing else has already done it.

  // The staff-gated transitions (release/refund/proceed) flip `status`
  // themselves, so for those paths the predicate below matches nothing and this
  // is a no-op. It matters for the PERMISSIONLESS escape hatch: that path has no
  // staff RPC, and it only mirrors the status when the relayed tx happens to be
  // COMPLETE already. In the usual case the relay returns 202 (accepted, not yet
  // mined) and nothing flipped the row — so a fully settled deal sat at ESCROW
  // (or WAITING) forever, invisible to the seller's and buyer's UIs.

  // The status predicate keeps it idempotent and guarantees we never overwrite a
  // status another path set.
  const terminal = status === "RELEASED" ? "COMPLETED" : "CANCELLED";
  await admin
    .from("wl_deals")
    .update({ status: terminal })
    .eq("on_chain_deal_id", contractId)
    .in("status", ["ESCROW", "WAITING"]);
}

/**
 * bug #40 — `DealDelivered` was never handled, so the indexer could not
 * reconcile a delivery whose app-side POST was lost (the Circle SDK callback
 * resolving to null, the tab closing mid-flow, a network blip between the
 * signature and the confirm call). The chain then said `delivered = true` while
 * `wl_deals.delivered_at` stayed NULL — and because `markDelivered` is ONE-WAY
 * on-chain (the contract rejects a second call), the app could never repair it
 * either. The deal was permanently stuck: the buyer never saw "Confirm
 * receipt", and the 7-day confirm clock never started in the UI.
 *
 * `confirmDeadline` comes straight from the event (the contract's own
 * `block.timestamp + CONFIRM_WINDOW`), so the DB clock matches the chain exactly.
 * Idempotent: it only stamps while `delivered_at` is still NULL, so a later
 * event — or the app's own POST, whichever lands first — can never move a
 * recorded delivery time.
 */
async function markDealDelivered(
  admin: ReturnType<typeof supabaseAdminClient>,
  contractId: string,
  txHash: string,
  confirmDeadlineSec: number
): Promise<void> {
  await admin
    .from("wl_deals")
    .update({
      delivered_at: new Date().toISOString(),
      confirm_deadline: new Date(confirmDeadlineSec * 1000).toISOString(),
      on_chain_tx_hash: txHash,
    })
    .eq("on_chain_deal_id", contractId)
    .is("delivered_at", null);
}

/**
 * bug #40 — same class as `DealDelivered`: a dispute whose app-side POST was
 * lost left the row at ESCROW while the chain had already frozen the deal
 * (blocking the release escape hatch, and starting the 30-day backstop clock).
 * Mirror it, but only from a NON-disputed state so the app's own transition
 * (which also records `disputed_at`) always wins when it ran.
 */
async function markDealDisputed(
  admin: ReturnType<typeof supabaseAdminClient>,
  contractId: string,
  txHash: string
): Promise<void> {
  await admin
    .from("wl_deals")
    .update({
      status: "DISPUTED",
      disputed_at: new Date().toISOString(),
      on_chain_tx_hash: txHash,
    })
    .eq("on_chain_deal_id", contractId)
    .in("status", ["ESCROW", "WAITING"]);
}

/**
 * Processes one bounded batch of escrow lifecycle events and advances the cursor.
 * Safe to call repeatedly (idempotent DB writes). Returns a summary for logging.
 */
export async function runIndexerOnce(): Promise<IndexerRunResult> {
  if (!isReady()) return { ran: false, reason: "ESCROW_CONTRACT_ADDRESS not set" };

  const client = arcPublicClient();
  const admin = supabaseAdminClient();

  const head = await client.getBlockNumber();
  const safeHead = head > CONFIRMATIONS ? head - CONFIRMATIONS : 0n;

  const fromBlock = await getFromBlock(admin, safeHead);
  if (fromBlock > safeHead) {
    return { ran: false, reason: "caught up", fromBlock: fromBlock.toString() };
  }

  const toBlock =
    safeHead - fromBlock > MAX_BLOCK_SPAN ? fromBlock + MAX_BLOCK_SPAN : safeHead;

  const rawLogs = (await client.getLogs({
    address: ESCROW_CONTRACT_ADDRESS,
    fromBlock,
    toBlock,
  })) as Log[];

  const events = parseEventLogs({ abi: LIFECYCLE_ABI, logs: rawLogs });

  let processed = 0;
  for (const ev of events) {
    const txHash = ev.transactionHash ?? "";
    try {
      switch (ev.eventName) {
        case "OrderReleased":
          await markOrder(admin, ev.args.id.toString(), "RELEASED", txHash);
          processed++;
          break;
        case "OrderRefunded":
          await markOrder(admin, ev.args.id.toString(), "REFUNDED", txHash);
          processed++;
          break;
        case "DealReleased":
          await markDeal(admin, ev.args.id.toString(), "RELEASED", txHash);
          processed++;
          break;
        case "DealRefunded":
          await markDeal(admin, ev.args.id.toString(), "REFUNDED", txHash);
          processed++;
          break;
        // Fraud settlement: the buyer is refunded AND the seller's collateral is
        // forfeited to them. The ABI has carried this event all along, but the
        // switch had no case for it — so a slashed deal kept `slash_pending`
        // forever, and reconciliation could not tell "slash still in flight" from
        // "slash done". The money moved; only the status never caught up.
        // Recorded as REFUNDED because that is what happened to the buyer's
        // funds; `collateral_slashed` on the row records the forfeiture.
        case "DealRefundedWithSlash":
          await markDeal(admin, ev.args.id.toString(), "REFUNDED", txHash);
          processed++;
          break;
        // bug #40 — these two were parsed but never applied, so a lost
        // app-side POST (SDK callback → null, tab closed mid-flow) left the DB
        // behind the chain with NO self-healing path. See the helpers above.
        case "DealDelivered":
          await markDealDelivered(
            admin,
            ev.args.id.toString(),
            txHash,
            Number(ev.args.confirmDeadline)
          );
          processed++;
          break;
        case "DealDisputed":
          await markDealDisputed(admin, ev.args.id.toString(), txHash);
          processed++;
          break;
        case "FeesCollected":
          // No row to update; recorded for observability only.
          console.log(
            `[indexer] FeesCollected → ${ev.args.amount.toString()} to ${ev.args.treasury} (tx ${txHash})`
          );
          processed++;
          break;
      }
    } catch (e) {
      console.error(`[indexer] failed to apply ${ev.eventName} (tx ${txHash}):`, e);
    }
  }

  await setLastProcessedBlock(admin, toBlock);

  return {
    ran: true,
    fromBlock: fromBlock.toString(),
    toBlock: toBlock.toString(),
    processed,
  };
}
