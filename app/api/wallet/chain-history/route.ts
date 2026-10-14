import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { scanWalletHistory, getUnifiedHistory } from "@/lib/wallet/chain-indexer";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";

/**
 * GET /api/wallet/chain-history?sync=1
 *
 * Returns the unified wallet history (DB txs + on-chain native USDC transfers).
 *
 * - Without `sync`: reads from the cache only (fast).
 * - With `sync=1`: runs an incremental RPC scan first, then returns the merged
 *   result. Safe to call repeatedly — it resumes from `last_scanned_block`.
 *
 * Graceful degradation: if the `wallet_chain_txs` table has not been created
 * yet (Postgres 42P01), sync is skipped and the DB-only history is returned
 * with `needsMigration: true` so the caller can prompt.
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);

  const admin = supabaseAdminClient();
  const { data: wallet } = await admin
    .from("wallets")
    .select("id,address,last_scanned_block")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!wallet) {
    return jsonError("wallet not found", 404);
  }

  const shouldSync = req.nextUrl.searchParams.get("sync") === "1";
  let needsMigration = false;

  if (shouldSync) {
    try {
      await scanWalletHistory(wallet.id, wallet.address);
    } catch (e: any) {
      const msg: string = e?.message ?? e?.code ?? String(e);
      // Postgres 42P01 = relation does not exist → migration not applied yet
      if (msg.includes("42P01") || /wallet_chain_txs/i.test(msg)) {
        needsMigration = true;
      }
      // Non-fatal: still return whatever cache/DB rows we have
      console.error("[chain-history] scan failed:", msg);
    }
  }

  let history: Awaited<ReturnType<typeof getUnifiedHistory>> = [];
  try {
    history = await getUnifiedHistory(wallet.id, wallet.address);
  } catch (e: any) {
    const msg: string = e?.message ?? String(e);
    if (msg.includes("42P01") || /wallet_chain_txs/i.test(msg)) {
      needsMigration = true;
      // Fall back to DB-only history so the page still renders
      const { data: dbRows } = await admin
        .from("wallet_txs")
        .select("id,type,label,sub,amount,status,created_at,dest_address,metadata")
        .eq("wallet_id", wallet.id)
        .order("created_at", { ascending: false })
        .limit(100);
      const addr = wallet.address.toLowerCase();
      history = (dbRows ?? []).map((r) => ({
        source: "db" as const,
        txHash: (r.metadata as any)?.arc_tx_hash ?? null,
        blockNumber: null,
        from: r.type === "out" ? addr : (r.dest_address ?? null),
        to: r.type === "in" ? addr : (r.dest_address ?? null),
        amount: String(r.amount),
        direction: r.type as "in" | "out",
        label: r.label,
        status: r.status,
        createdAt: r.created_at,
        dbId: r.id,
      }));
    } else {
      console.error("[chain-history] read failed:", msg);
    }
  }

  return jsonOk({
    address: wallet.address,
    lastScannedBlock: wallet.last_scanned_block,
    needsMigration,
    history,
  });
}
