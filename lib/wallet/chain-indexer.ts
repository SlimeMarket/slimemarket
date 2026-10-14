import { parseAbiItem, type Hex } from "viem";
import { arcPublicClient, ARC_NATIVE_USDC_EMITTER } from "@/lib/arc";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

/** Arc RPC range limit observed in practice (10k hard, 5k safe). */
const CHUNK_SIZE = 5000n;

/**
 * Chunks scanned in parallel per batch (2 RPC calls each).
 *
 * Measured on Arc testnet: the RPC answers "Request exceeds defined limit"
 * beyond ~8 concurrent eth_getLogs calls, so keep in-flight well under that.
 */
const CHUNK_CONCURRENCY = 2;

/**
 * Pause between batches. The RPC also throttles eth_getLogs per time window
 * (~800 calls/min observed): without pacing, the first ~400 chunks succeed
 * and every later call in the same run is rejected until the window refills.
 */
const BATCH_DELAY_MS = 1000;

/** Backoff schedule for a single chunk's two RPC calls (transient limits). */
const CHUNK_RETRIES = 3;
const CHUNK_RETRY_BASE_MS = 500;

/** First-ever scan looks back this far (≈ days on Arc), not from genesis. */
const FIRST_SCAN_WINDOW = 50_000n;

/** How many chunks to scan in one request before yielding (partial mode). */
const DEFAULT_MAX_CHUNKS = 10; // 10 × 5k = 50k blocks per refresh

/** Arc native USDC uses 18 decimals; the app DB stores micro-USDC (6 dp). */
const DECIMALS_DIFF = 1_000_000_000_000n; // 10^(18-6)

export interface ChainTx {
  txHash: string;
  blockNumber: bigint;
  from: string;
  to: string;
  amountMicro: bigint;
  direction: "in" | "out";
}

export interface ScanResult {
  txs: ChainTx[];
  scannedUpTo: bigint;
  hasMore: boolean;
}

/**
 * Incrementally scan native-USDC Transfer events for a single wallet address.
 *
 * - Resumes from `wallets.last_scanned_block` (or a bounded recent window).
 * - Stops at `head` or after `maxChunks` — whichever comes first.
 * - Upserts rows into `wallet_chain_txs` and updates the resume cursor.
 */
export async function scanWalletHistory(
  walletId: string,
  address: string,
  opts?: { maxChunks?: number },
): Promise<ScanResult> {
  const client = arcPublicClient();
  const head = await client.getBlockNumber();
  const checksumAddr = address.toLowerCase() as Hex;
  const maxChunks = opts?.maxChunks ?? DEFAULT_MAX_CHUNKS;

  const admin = supabaseAdminClient();
  const { data: walletRow } = await admin
    .from("wallets")
    .select("last_scanned_block")
    .eq("id", walletId)
    .maybeSingle();

  let fromBlock: bigint;
  if (walletRow?.last_scanned_block != null) {
    fromBlock = BigInt(walletRow.last_scanned_block) + 1n;
  } else {
    // Never scanned: look back a bounded window instead of walking from
    // genesis — walking 2.3M blocks would take minutes and time out the UI.
    // Wallets with pre-window history keep those txs in wallet_txs (DB) anyway.
    fromBlock = head > FIRST_SCAN_WINDOW ? head - FIRST_SCAN_WINDOW : 0n;
  }

  if (fromBlock > head) {
    return { txs: [], scannedUpTo: head, hasMore: false };
  }

  // Build the chunk list up-front so batches can run in parallel.
  const chunks: { from: bigint; to: bigint }[] = [];
  {
    let f = fromBlock;
    while (f <= head && chunks.length < maxChunks) {
      const t = f + CHUNK_SIZE > head ? head : f + CHUNK_SIZE;
      chunks.push({ from: f, to: t });
      f = t + 1n;
    }
  }

  /** One chunk → txs, or null after all retries failed (cursor does NOT advance past it). */
  const scanChunk = async (
    c: { from: bigint; to: bigint },
    attempt = 0,
  ): Promise<ChainTx[] | null> => {
    try {
      const [outLogs, inLogs] = await Promise.all([
        client.getLogs({
          address: ARC_NATIVE_USDC_EMITTER,
          event: TRANSFER_EVENT,
          args: { from: checksumAddr },
          fromBlock: c.from,
          toBlock: c.to,
        }),
        client.getLogs({
          address: ARC_NATIVE_USDC_EMITTER,
          event: TRANSFER_EVENT,
          args: { to: checksumAddr },
          fromBlock: c.from,
          toBlock: c.to,
        }),
      ]);

      const rows: ChainTx[] = [];
      for (const log of outLogs) {
        if (!log.transactionHash || log.blockNumber == null) continue;
        if (!log.args.from || !log.args.to || log.args.value == null) continue;
        rows.push({
          txHash: log.transactionHash,
          blockNumber: log.blockNumber,
          from: log.args.from,
          to: log.args.to,
          amountMicro: log.args.value / DECIMALS_DIFF,
          direction: "out",
        });
      }
      for (const log of inLogs) {
        if (!log.transactionHash || log.blockNumber == null) continue;
        if (!log.args.from || !log.args.to || log.args.value == null) continue;
        rows.push({
          txHash: log.transactionHash,
          blockNumber: log.blockNumber,
          from: log.args.from,
          to: log.args.to,
          amountMicro: log.args.value / DECIMALS_DIFF,
          direction: "in",
        });
      }
      return rows;
    } catch {
      // Arc RPC answers "Request exceeds defined limit" when too many
      // eth_getLogs are in flight / too fast. Back off and retry.
      if (attempt >= CHUNK_RETRIES) return null;
      await new Promise((r) => setTimeout(r, CHUNK_RETRY_BASE_MS * 2 ** attempt));
      return scanChunk(c, attempt + 1);
    }
  };

  const allTxs: ChainTx[] = [];
  // Cursor only advances over CONTIGUOUS scanned ranges, so a failed chunk is
  // retried on the next run instead of being silently skipped forever.
  let scannedUpTo = fromBlock - 1n;

  for (let i = 0; i < chunks.length; i += CHUNK_CONCURRENCY) {
    const batch = chunks.slice(i, i + CHUNK_CONCURRENCY);
    const results = await Promise.all(batch.map((c) => scanChunk(c)));
    if (results.some((r) => r === null)) break; // persistent failure; retried next run
    for (const rows of results) {
      if (rows) allTxs.push(...rows);
    }
    scannedUpTo = batch[batch.length - 1]!.to;
    if (i + CHUNK_CONCURRENCY < chunks.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  // Upsert discovered txs (idempotent)
  if (allTxs.length > 0) {
    const rows = allTxs.map((t) => ({
      wallet_id: walletId,
      tx_hash: t.txHash,
      block_number: Number(t.blockNumber),
      from: t.from,
      to: t.to,
      amount: Number(t.amountMicro),
      direction: t.direction,
    }));

    await admin
      .from("wallet_chain_txs")
      .upsert(rows, { onConflict: "wallet_id,tx_hash" });
  }

  await admin
    .from("wallets")
    .update({ last_scanned_block: Number(scannedUpTo) })
    .eq("id", walletId);

  const hasMore = scannedUpTo < head;
  allTxs.sort((a, b) => (a.blockNumber > b.blockNumber ? -1 : 1));

  return { txs: allTxs, scannedUpTo, hasMore };
}

/**
 * Read cached chain history for a wallet (no RPC calls).
 * Merges with wallet_txs so the UI sees a unified feed.
 */
export async function getUnifiedHistory(walletId: string, address: string) {
  const admin = supabaseAdminClient();

  const [{ data: chainRows }, { data: dbRows }] = await Promise.all([
    admin
      .from("wallet_chain_txs")
      .select("tx_hash,block_number,from,to,amount,direction,scanned_at")
      .eq("wallet_id", walletId)
      .order("block_number", { ascending: false })
      .limit(100),
    admin
      .from("wallet_txs")
      .select("id,type,label,sub,amount,status,method,created_at,circle_tx_id,dest_address,metadata")
      .eq("wallet_id", walletId)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  const normalizedAddr = address.toLowerCase();

  const chainItems = (chainRows ?? []).map((r) => ({
    source: "chain" as const,
    txHash: r.tx_hash,
    blockNumber: r.block_number,
    from: r.from,
    to: r.to,
    amount: String(r.amount),
    direction: r.direction as "in" | "out",
    label: r.direction === "in" ? "Receive" : "Send",
    status: "done" as const,
    createdAt: r.scanned_at,
    dbId: null as string | null,
  }));

  const dbItems = (dbRows ?? []).map((r) => ({
    source: "db" as const,
    txHash: (r.metadata as any)?.arc_tx_hash ?? null,
    blockNumber: null as number | null,
    from: r.type === "out" ? normalizedAddr : (r.dest_address ?? null),
    to: r.type === "in" ? normalizedAddr : (r.dest_address ?? null),
    amount: String(r.amount),
    direction: r.type as "in" | "out",
    label: r.label,
    status: r.status,
    createdAt: r.created_at,
    dbId: r.id,
  }));

  const byHash = new Map<string, (typeof chainItems)[0] | (typeof dbItems)[0]>();
  for (const item of chainItems) {
    if (item.txHash) byHash.set(item.txHash.toLowerCase(), item);
  }
  for (const item of dbItems) {
    if (item.txHash) {
      byHash.set(item.txHash.toLowerCase(), item);
    } else {
      byHash.set(`db-${item.dbId}`, item);
    }
  }

  const merged = Array.from(byHash.values()).sort((a, b) => {
    const ta = new Date(a.createdAt).getTime();
    const tb = new Date(b.createdAt).getTime();
    return tb - ta;
  });

  return merged;
}
