/**
 * Dispute resolution logic for marketplace orders.
 *
 * Flow:
 *   1. Buyer appeals (SENT → DISPUTED) — timer paused, funds in contract
 *   2. System auto-creates mediasi chat thread (buyer + seller + admin)
 *   3. Admin/MM reviews evidence in chat
 *   4. Admin resolves: "refund" (buyer gets 100%) or "release" (seller gets amount - 2% marketplace fee; 2% buyer fee already collected)
 *   5. Contract executes the resolution on-chain
 */

import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { releaseOrderOnChain, refundOrderOnChain, isContractReady } from "@/lib/contracts/escrow-client";
import { createMmAuditLog } from "@/lib/mm";
import { notifyUser } from "@/lib/notif";
import { disputeResolvedTemplate } from "@/lib/notif/templates";
import { ONCHAIN_FUNDS_ENABLED } from "@/lib/wallet/onchain-funding";
import { resolveSettlementRail, unresolvedRailError } from "./settlement-rail";
import { recordLifecycleEvent } from "./patterns";
import { disputeFinalStatus, settlementActionForDisputeResolution } from "./auto-settlement";
import type { CurrentUser } from "@/lib/auth-ucw";
import { ARC_EXPLORER_TX_BASE } from "@/lib/arc";

const PLATFORM_WALLET_ID = process.env.PLATFORM_CIRCLE_WALLET_ID ?? "";

/**
 * .A — pure testable seam: which dispute-resolution RPC a settlement
 * runs against, given the funding mode. Non-custodial must NOT credit the
 * ledger (the on-chain relay pays directly); custodial legacy keeps the
 * original ledger-moving atomic.
 */
export function disputeRpcName(
  nonCustodial: boolean = ONCHAIN_FUNDS_ENABLED,
): "resolve_dispute_atomic" | "resolve_dispute_noncustodial" {
  return nonCustodial ? "resolve_dispute_noncustodial" : "resolve_dispute_atomic";
}

export interface DisputeListItem {
  id: string;
  orderId: string;
  productName: string;
  buyerName: string;
  sellerName: string;
  amount: string;
  reason: string;
  status: string;
  createdAt: string;
  appealedAt: string;
  chatThreadId: string | null;
}

/** List all DISPUTED orders for admin dashboard */
export async function listDisputes(): Promise<DisputeListItem[]> {
  const admin = supabaseAdminClient();
  const { data, error } = await admin
    .from("orders")
    .select(`
      id, status, amount, cancel_reason, created_at, updated_at,
      product_id, buyer_id, store_id,
      products ( name ),
      stores ( name, owner_user_id )
    `)
    .eq("status", "DISPUTED")
    .order("updated_at", { ascending: false });

  if (error || !data) return [];

  const disputes: DisputeListItem[] = [];
  for (const row of data) {
    // Get buyer name
    const { data: buyer } = await admin.from("users").select("name").eq("id", row.buyer_id).maybeSingle();

    // Check if mediasi thread exists
    const { data: thread } = await admin
      .from("chat_threads")
      .select("id")
      .eq("type", "dispute")
      .eq("order_id", row.id)
      .maybeSingle();

    disputes.push({
      id: row.id,
      orderId: row.id,
      productName: ((row.products as unknown as { name: string } | { name: string }[] | null) instanceof Array
        ? (row.products as unknown as { name: string }[])[0]?.name
        : (row.products as unknown as { name: string } | null)?.name) ?? "Unknown",
      buyerName: buyer?.name ?? "Unknown",
      sellerName: ((row.stores as unknown as { name: string } | { name: string }[] | null) instanceof Array
        ? (row.stores as unknown as { name: string }[])[0]?.name
        : (row.stores as unknown as { name: string } | null)?.name) ?? "Unknown",
      amount: row.amount?.toString() ?? "0",
      reason: (row.cancel_reason as string) ?? "No reason",
      status: row.status as string,
      createdAt: row.created_at as string,
      appealedAt: row.updated_at as string,
      chatThreadId: thread?.id ?? null,
    });
  }
  return disputes;
}

/** Create mediasi chat thread for a dispute (buyer + seller + admin) */
export async function ensureDisputeThread(orderId: string): Promise<string> {
  const admin = supabaseAdminClient();

  // 0094 — one thread per (type, order_id). `limit(1)` instead of
  // `.maybeSingle()`, which errors (PGRST116) once duplicates exist and would
  // make this look like "no thread yet".
  const findExisting = async (): Promise<string | null> => {
    const { data } = await admin
      .from("chat_threads")
      .select("id")
      .eq("type", "dispute")
      .eq("order_id", orderId)
      .order("created_at", { ascending: true })
      .limit(1);
    return (data?.[0]?.id as string | undefined) ?? null;
  };

  const existingId = await findExisting();
  if (existingId) return existingId;

  // Get order parties
  const { data: order } = await admin
    .from("orders")
    .select("buyer_id, store_id")
    .eq("id", orderId)
    .maybeSingle();

  if (!order) throw new Error("order not found");

  const buyerId = order.buyer_id as string;

  // Get seller via store
  const { data: store } = await admin
    .from("stores")
    .select("owner_user_id")
    .eq("id", order.store_id as string)
    .maybeSingle();

  const sellerId = store?.owner_user_id as string | undefined;
  if (!sellerId) throw new Error("seller not found");

  // Get admin users
  const { data: admins } = await admin
    .from("users")
    .select("id")
    .eq("role", "Admin");
  const adminIds = (admins ?? []).map(a => a.id as string);

  const participantIds = [...new Set([buyerId, sellerId, ...adminIds])];

  const { data: thread, error } = await admin
    .from("chat_threads")
    .insert({
      type: "dispute",
      status: "active",
      order_id: orderId,
      participant_ids: participantIds,
      created_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error || !thread) {
    // 23505 = unique_violation → a concurrent request created the thread first.
    // Re-select rather than throwing.
    if (error?.code === "23505") {
      const raced = await findExisting();
      if (raced) return raced;
    }
    throw new Error(`create dispute thread: ${error?.message ?? "no row returned"}`);
  }

  // Post system message
  await admin.from("chat_messages").insert({
    thread_id: thread.id,
    sender_id: null,
    sender_role: "system",
    text: "Dispute opened. Admin/MM will review. Both parties can submit evidence here.",
    created_at: new Date().toISOString(),
  });

  return thread.id;
}

/** Resolve dispute: admin decides refund or release */
export async function resolveDispute(
  orderId: string,
  admin: CurrentUser,
  decision: "refund" | "release",
  reason: string
): Promise<{ status: string; onChain: boolean }> {
  // Pure decision mapping (TDD-pinned): 'refund' | 'release' → relay action.
  // Throws on anything else so the route never relays an unknown outcome.
  const action = settlementActionForDisputeResolution(decision);

  const db = supabaseAdminClient();

  // Verify order is DISPUTED
  const { data: order } = await db
    .from("orders")
    .select("status, buyer_id, amount, on_chain_order_id")
    .eq("id", orderId)
    .maybeSingle();

  if (!order) throw new Error("order not found");
  if (order.status !== "DISPUTED") throw new Error(`order is ${order.status}, not DISPUTED`);

  let onChain = false;

  // the settlement rail comes from the ORDER, not the env flag.
  // Keying the RPC off the flag while keying the relay off isContractReady() +
  // a non-null id meant a flag change between creation and resolution either
  // double-paid (ledger credit AND on-chain payout) or settled with no payout.
  const rail = resolveSettlementRail({
    onChainOrderId: order.on_chain_order_id as string | null,
    onchainFundsEnabled: ONCHAIN_FUNDS_ENABLED,
  });
  if (rail === "unresolved") throw unresolvedRailError();

  // .A — dispute resolution RPC selection, now driven by the rail:
  //   on-chain: resolve_dispute_noncustodial — status flip only, money moves
  //     EXCLUSIVELY via the on-chain relay below. The custodial variant would
  //     double-book (phantom ledger credit + 100% on-chain payout, and its
  //     98/2 fee split is also wrong for v4).
  //   ledger (custodial): resolve_dispute_atomic (ledger credit) — unchanged.
  const rpcName = disputeRpcName(rail === "on-chain");
  const { error: rpcErr } = await db.rpc(rpcName, {
    p_order_id: orderId,
    p_actor_id: admin.id,
    p_decision: action,
    p_reason: reason,
  });
  if (rpcErr) throw new Error(`${rpcName}: ${rpcErr.message}`);

  // (c) RESOLVED lifecycle row right after the atomic settlement (arc
  // ordering: BEFORE further orders-row mutation). Best-effort — a missing
  // row degrades the timeline, never the payout.
  let amountMicro: bigint = 0n;
  try { amountMicro = BigInt((order.amount as string | number | null)?.toString() ?? "0"); } catch { amountMicro = 0n; }
  await recordLifecycleEvent(
    db as unknown as Parameters<typeof recordLifecycleEvent>[0],
    {
      orderId,
      operation: "RESOLVED",
      txHash: null,
      amountMicro,
      note: `dispute-resolved:${action}: ${reason}`,
    },
    { triggeredBy: admin.id },
  );

  // On-chain execution (best-effort; DB ledger already updated by the RPC).
  // Track success/failure in DB columns so the reconcile cron can retry.
  // only relay for on-chain orders (see the rail note above).
  let circleTxId: string | undefined;
  if (rail === "on-chain" && isContractReady() && order.on_chain_order_id) {
    const onChainId = order.on_chain_order_id as string;
    try {
      const result = decision === "refund"
        ? await refundOrderOnChain(onChainId, PLATFORM_WALLET_ID)
        : await releaseOrderOnChain(onChainId, PLATFORM_WALLET_ID);
      circleTxId = result?.id;
      onChain = true;
      // Optimistic marker; indexer sets terminal RELEASED/REFUNDED on event.
      await db.from("orders").update({
        on_chain_status: decision === "refund" ? "refund_pending" : "release_pending",
        on_chain_circle_tx_id: result?.id ?? null,
        on_chain_last_attempt_at: new Date().toISOString(),
      }).eq("id", orderId);
      await createMmAuditLog({
        mmUserId: admin.id, mmWalletId: PLATFORM_WALLET_ID,
        actorType: "user",
        action: decision === "refund" ? "REFUND_ORDER" : "RELEASE_ORDER",
        refId: orderId,
        circleTxId,
        detail: { reason, decision, triggeredBy: admin.name, type: "dispute-resolution", onChainOrderId: onChainId },
      });
    } catch (e) {
      const errMsg = (e as Error).message;
      console.error(`on-chain ${decision}Order failed:`, e);
      await db.from("orders").update({
        on_chain_status: decision === "refund" ? "refund_failed" : "release_failed",
        on_chain_error: errMsg,
        on_chain_retry_count: 0,
        on_chain_last_attempt_at: new Date().toISOString(),
      }).eq("id", orderId);
      await createMmAuditLog({
        mmUserId: null, mmWalletId: PLATFORM_WALLET_ID,
        actorType: "platform",
        action: decision === "refund" ? "REFUND_ORDER" : "RELEASE_ORDER",
        refId: orderId,
        detail: { type: "on-chain-release-failed", error: errMsg, onChainOrderId: onChainId, decision, reason, triggeredBy: admin.id },
      }).catch(() => {});
    }
  }

  // Post resolution in dispute thread
  const threadId = await ensureDisputeThread(orderId).catch(() => null);
  if (threadId) {
    await db.from("chat_messages").insert({
      thread_id: threadId,
      sender_id: admin.id,
      sender_role: "admin",
      text: `Dispute resolved: ${decision.toUpperCase()}. Reason: ${reason}`,
      created_at: new Date().toISOString(),
    });
    await db.from("chat_threads").update({ status: "resolved" }).eq("id", threadId);
  }

  // notify the winning side. The money already moved on-chain (refund →
  // buyer's wallet; release → seller's wallet, minus the 2% marketplace fee);
  // before this, resolving a dispute notified nobody at all.
  const shortId = orderId.slice(0, 8);
  let winnerId: string | undefined = order.buyer_id as string;
  if (decision !== "refund") {
    const { data: ord } = await db.from("orders").select("store_id").eq("id", orderId).maybeSingle();
    if (ord?.store_id) {
      const { data: st } = await db.from("stores").select("owner_user_id").eq("id", ord.store_id as string).maybeSingle();
      winnerId = st?.owner_user_id as string | undefined;
    } else {
      winnerId = undefined;
    }
  }

  if (winnerId) {
    const { data: orderRow } = await db.from("orders")
      .select("amount, product_id, on_chain_tx_hash")
      .eq("id", orderId).maybeSingle();
    const { data: product } = await db.from("products")
      .select("name").eq("id", orderRow?.product_id as string | undefined || "").maybeSingle();

    const amountUsdc = (Number(orderRow?.amount || 0) / 1_000_000).toFixed(2);
    const template = disputeResolvedTemplate({
      orderId,
      itemName: (product?.name as string) || "Order item",
      amountUsdc,
      winner: decision === "refund" ? "buyer" : "seller",
      resolution: decision as "refund" | "release" | "split",
      reason: reason || undefined,
      txHash: (orderRow?.on_chain_tx_hash as string) || null,
      explorerUrl: ARC_EXPLORER_TX_BASE,
      appUrl: process.env.NEXT_PUBLIC_APP_URL || "https://slimemarket.app",
    });

    await notifyUser(winnerId, {
      icon: decision === "refund" ? "undo-2" : "check-check",
      tone: decision === "refund" ? "emerald" : "cyan",
      title: decision === "refund" ? "Dispute Resolved — Refund Sent" : "Dispute Resolved — Funds Released",
      text: decision === "refund"
        ? `Order ${shortId}: the tribunal decided in your favour. The item amount is on its way back to your wallet. The 2% service fee is not refundable.`
        : `Order ${shortId}: the tribunal decided in your favour. Funds have been released to your wallet.`,
      link: "orders",
      email: template,
    }).catch(() => {});
  }

  return {
    status: disputeFinalStatus(decision),
    onChain,
  };
}
