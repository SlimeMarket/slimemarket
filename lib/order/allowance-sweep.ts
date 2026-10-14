import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { arcPublicClient, ARC_USDC_CONTRACT } from "@/lib/arc";
import { createMmAuditLog } from "@/lib/mm";
import { logger } from "@/lib/logger";
import type { Hex } from "viem";

const ESCROW_CONTRACT_ADDRESS = process.env.ESCROW_CONTRACT_ADDRESS ?? "";

/** USDC ERC-20 allowance ABI. */
const ERC20_ALLOWANCE_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** Draft age threshold before we consider an approve "dangling". */
const DANGLING_THRESHOLD_MINUTES = 5;

export interface AllowanceSweepResult {
  scanned: number;
  danglingDetected: number;
  failedReads: number;
}

interface DraftRow {
  id: string;
  buyer_id: string;
  amount: string;
  created_at: string;
}

/**
 * Detects "dangling" USDC allowances: the buyer signed an `approve(escrow,
 * itemAmount)` call at checkout, but the DCW relayer's `createOrderFor` never
 * confirmed (server crash, Circle outage, contract paused, etc.). The buyer's
 * UCW now has a standing allowance to the escrow contract that nothing will
 * consume — an exposure window where a later-submitted createOrderFor could
 * still pull the funds.
 *
 * Sweep logic:
 *   - Scan `orders` where status='PENDING' + on_chain_order_id IS NULL +
 *     created_at < now - 5 min + payment='Onchain' (non-custodial drafts).
 *   - For each, read on-chain `USDC.allowance(buyer, escrow)`.
 *   - If allowance > 0, mark the order FAILED + audit ALLOWANCE_DANGLING +
 *     notify the buyer (via the existing notifyUser helper).
 *
 * The buyer can then revoke the allowance via POST /api/orders/[id]/revoke-allowance
 * (Phase 5.3) which issues a fresh UCW CONTRACT_EXECUTION challenge for
 * `approve(escrow, 0)`.
 *
 * CRON: call from `app/api/admin/sweep/allowance/route.ts` every 5 minutes.
 * Idempotent — orders already in FAILED state are skipped.
 */
export async function sweepDanglingAllowances(): Promise<AllowanceSweepResult> {
  if (!ESCROW_CONTRACT_ADDRESS) {
    return { scanned: 0, danglingDetected: 0, failedReads: 0 };
  }

  const admin = supabaseAdminClient();
  const since = new Date(Date.now() - DANGLING_THRESHOLD_MINUTES * 60_000).toISOString();

  // Scan non-custodial drafts (payment='Onchain') that never got an on-chain
  // order id within the dangling threshold.
  // FIX `on_chain_circle_tx_id IS NULL` is REQUIRED.

  // An order whose relay WAS submitted but whose contract id hasn't been
  // resolved yet has status PENDING + on_chain_order_id NULL + a live
  // on_chain_circle_tx_id, and its allowance is not consumed until the relay
  // mines. Without this guard the sweep treated such an in-flight order as a
  // "dangling allowance" and CANCELLED it — which also hides it from
  // `reconcileMissingOnchainIds` (that scan excludes CANCELLED), so the contract
  // id could never be recovered and the buyer's escrowed USDC was stranded.
  // Same failure mode as the expired-draft sweep in draft-cleanup.ts.
  const { data: drafts, error } = await admin
    .from("orders")
    .select("id, buyer_id, amount, created_at")
    .eq("status", "PENDING")
    .eq("payment", "Onchain")
    .is("on_chain_order_id", null)
    .is("on_chain_circle_tx_id", null)
    .lt("created_at", since);

  if (error) {
    logger.error({ err: error.message }, "allowance-sweep: select failed");
    return { scanned: 0, danglingDetected: 0, failedReads: 0 };
  }

  let danglingDetected = 0;
  let failedReads = 0;
  const scanned = drafts?.length ?? 0;
  const client = arcPublicClient();

  for (const draft of (drafts ?? []) as DraftRow[]) {
    // Look up buyer's wallet address.
    const { data: wallet } = await admin.from("wallets")
      .select("address").eq("user_id", draft.buyer_id).maybeSingle();
    if (!wallet?.address) {
      failedReads++;
      continue;
    }

    let allowance: bigint;
    try {
      allowance = await client.readContract({
        address: ARC_USDC_CONTRACT,
        abi: ERC20_ALLOWANCE_ABI,
        functionName: "allowance",
        args: [wallet.address as Hex, ESCROW_CONTRACT_ADDRESS as Hex],
      }) as bigint;
    } catch (e) {
      logger.warn({ orderId: draft.id, err: (e as Error).message }, "allowance-sweep: readContract failed");
      failedReads++;
      continue;
    }

    if (allowance > 0n) {
      // Dangling allowance detected. Mark order FAILED so it stops re-appearing
      // in the scan, then audit + notify the buyer.
      await admin.from("orders")
        .update({ status: "CANCELLED", cancel_reason: "dangling allowance (createOrderFor never confirmed)" })
        .eq("id", draft.id);

      await createMmAuditLog({
        mmUserId: null,
        mmWalletId: "system",
        actorType: "system",
        action: "ALLOWANCE_DANGLING",
        refId: draft.id,
        detail: {
          buyerId: draft.buyer_id,
          buyerAddress: wallet.address,
          allowanceMicro: allowance.toString(),
          orderAmountMicro: draft.amount,
          createdAt: draft.created_at,
        },
      }).catch(() => {});

      // Notify the buyer to revoke the allowance.
      try {
        const { notifyUser } = await import("@/lib/notif");
        await notifyUser(draft.buyer_id, {
          icon: "alert-triangle",
          tone: "amber",
          title: "Action Required: Revoke Unused Approval",
          text: `Your checkout (order ${draft.id.slice(0, 8)}) didn't complete on-chain. Revoke the unused USDC approval to keep your funds safe.`,
          link: "orders",
          email: true,
        });
      } catch { /* non-blocking */ }

      danglingDetected++;
      logger.warn({ orderId: draft.id, buyerId: draft.buyer_id, allowance: allowance.toString() }, "dangling allowance detected");
    }
  }

  return { scanned, danglingDetected, failedReads };
}
