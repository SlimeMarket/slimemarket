import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import type { CurrentUser } from "@/lib/auth-ucw";
import { promoteIfEligible } from "@/lib/roles";
import { releaseOrderOnChain, refundOrderOnChain, isContractReady } from "@/lib/contracts/escrow-client";
import { createMmAuditLog } from "@/lib/mm";
import { notifyUser } from "@/lib/notif";
import { orderCompletedTemplate } from "@/lib/notif/templates";
import { logger } from "@/lib/logger";
import { ONCHAIN_FUNDS_ENABLED } from "@/lib/wallet/onchain-funding";
import { resolveSettlementRail, unresolvedRailError } from "./settlement-rail";
import { bestEffortPersist, guardTransition, recordLifecycleEvent } from "./patterns";

/** Parse a DB amount column to bigint defensively (null/garbage → 0n for lifecycle-only use). */
function parseAmountOrZero(amount: string | number | null | undefined): bigint {
  if (amount === null || amount === undefined) return 0n;
  try {
    return BigInt(amount.toString());
  } catch {
    return 0n;
  }
}

/** Human-readable USDC for a notification body (micro-USDC in → "12.50"). */
function formatMicroForNotice(amount: string | number | null | undefined): string {
  return (Number(parseAmountOrZero(amount)) / 1_000_000).toFixed(2);
}

/** Resolve the seller (store owner) user id for an order. */
async function sellerIdForOrder(
  admin: ReturnType<typeof supabaseAdminClient>,
  orderId: string
): Promise<string | undefined> {
  const { data } = await admin
    .from("orders")
    .select("stores!inner ( owner_user_id )")
    .eq("id", orderId)
    .maybeSingle();
  return (data as { stores?: { owner_user_id?: string } } | null)?.stores?.owner_user_id;
}

const PLATFORM_WALLET_ID = process.env.PLATFORM_CIRCLE_WALLET_ID ?? "";
const RELEASE_DEADLINE_HOURS = 42;

/** SENT→DONE. Buyer only + platform auto after 42h. Seller receives amount -2% (marketplace seller fee); 2% buyer fee taken at creation. */
export async function confirmOrder(orderId: string, user: CurrentUser) {
  const admin = supabaseAdminClient();

  // (b) Preflight guard: turn the cryptic RPC raise into a clean 409.
  const { data: pre } = await admin.from("orders")
    .select("status, amount, on_chain_order_id").eq("id", orderId).maybeSingle();
  if (!pre) throw new Error("order not found");
  guardTransition(pre.status as string, ["SENT"], "release");

  // the settlement RAIL is a property of the ORDER, not of the
  // current env flag. Previously the ledger credit keyed off
  // ONCHAIN_FUNDS_ENABLED while the relay below keyed off isContractReady() +
  // a non-null on_chain_order_id. Flipping the flag between creation and release
  // therefore either paid the seller twice (ledger credit AND releaseOrder) or
  // marked the order DONE with no payout at all. See lib/order/settlement-rail.ts.
  const rail = resolveSettlementRail({
    onChainOrderId: pre.on_chain_order_id as string | null,
    onchainFundsEnabled: ONCHAIN_FUNDS_ENABLED,
  });

  // Non-custodial mode but no contract id → the USDC may already be in escrow
  // under an id we cannot read yet. Settling from the ledger would mint money
  // the platform does not hold; refusing lets reconcile/onchain-ids backfill it.
  if (rail === "unresolved") throw unresolvedRailError();

  // B4 — ledger-credit gate. `confirm_order_atomic` bundles the seller payout
  // credit into wallets.usdc_balance. When the money is ON-CHAIN (rail ===
  // "on-chain") the MarketEscrow.releaseOrder below pays the seller directly, so
  // crediting the legacy custodial ledger on top would double-book money the
  // platform no longer holds. The no-credit variant (migration 0048) keeps the
  // same guards, the SENT→DONE flip, and the buyer tx_count bump — only the
  // ledger/wallet credit is omitted. Custodial orders (rail === "ledger") are
  // unchanged.
  const { error } = rail === "on-chain"
    ? await admin.rpc("confirm_order_noncustodial", {
        p_order_id: orderId, p_actor_id: user.id,
      })
    : await admin.rpc("confirm_order_atomic", {
        p_order_id: orderId, p_actor_id: user.id,
      });
  if (error) throw new Error(error.message);

  // (c) RELEASED lifecycle row right after the atomic ledger release, BEFORE
  // any further orders-row mutation. Best-effort — never fails the release.
  await recordLifecycleEvent(
    admin as unknown as Parameters<typeof recordLifecycleEvent>[0],
    {
      orderId,
      operation: "RELEASED",
      txHash: null,
      amountMicro: parseAmountOrZero(pre.amount as string | null),
      note: "buyer-confirm",
    },
    { triggeredBy: user.id },
  );

  // On-chain contract release — driven by the ORDER's rail, not by the flag.
  if (rail === "on-chain" && isContractReady()) {
    // Get on-chain order ID (contract counter stored at checkout) BEFORE the
    // try/catch so the failure path can record it for reconciliation.
    const { data: orderRow } = await admin.from("orders")
      .select("on_chain_order_id").eq("id", orderId).maybeSingle();
    const onChainId = orderRow?.on_chain_order_id as string | null;
    if (onChainId) {
      try {
        const result = await releaseOrderOnChain(onChainId, PLATFORM_WALLET_ID);
        // (a) The on-chain release tx was submitted — a DB mirror failure must
        // not surface as a release failure; the reconcile cron backstops.
        await bestEffortPersist(
          "confirm:update-onchain-release-pending",
          async () => {
            const { error: upErr } = await admin.from("orders").update({
              on_chain_status: "release_pending",
              on_chain_circle_tx_id: result?.id ?? null,
              on_chain_last_attempt_at: new Date().toISOString(),
            }).eq("id", orderId);
            if (upErr) throw new Error(upErr.message);
          },
          { logger, context: { orderId, onChainId } },
        );
        await createMmAuditLog({
          mmUserId: null, mmWalletId: PLATFORM_WALLET_ID,
          actorType: "platform",
          action: "RELEASE_ORDER", refId: orderId,
          circleTxId: result?.id,
          detail: { triggeredBy: user.id, type: "buyer-confirm", onChainOrderId: onChainId },
        });
      } catch (e) {
        // P0-10 FIX: Track failure in DB columns so the reconcile cron can
        // retry. DB ledger is authoritative; on-chain mirror is retried by the
        // reconciliation job. Do NOT rollback DB state.
        const errMsg = (e as Error).message;
        console.error(`[on-chain] releaseOrder failed for order ${orderId} (buyer-confirm):`, e);
        await admin.from("orders").update({
          on_chain_status: "release_failed",
          on_chain_error: errMsg,
          on_chain_retry_count: 0,
          on_chain_last_attempt_at: new Date().toISOString(),
        }).eq("id", orderId);
        await createMmAuditLog({
          mmUserId: null, mmWalletId: PLATFORM_WALLET_ID,
          actorType: "platform",
          action: "RELEASE_ORDER", refId: orderId,
          detail: { type: "on-chain-release-failed", error: errMsg, onChainOrderId: onChainId, triggeredBy: user.id },
        }).catch(() => {});
      }
    }
  }

  promoteIfEligible(user.id).catch(() => {});

  // Notify seller: payout released (non-blocking).
  try {
    const sellerId = await sellerIdForOrder(admin, orderId);
    if (sellerId) {
      const { data: orderRow } = await admin.from("orders")
        .select("amount, buyer_fee, product_id, on_chain_tx_hash")
        .eq("id", orderId).maybeSingle();
      const { data: product } = await admin.from("products")
        .select("name").eq("id", orderRow?.product_id as string | undefined || "").maybeSingle();

      const amountMicro = parseAmountOrZero(orderRow?.amount as string | null);
      const feeMicro = parseAmountOrZero(orderRow?.buyer_fee as string | null);
      const totalMicro = amountMicro + feeMicro;
      const amountUsdc = (Number(amountMicro) / 1_000_000).toFixed(2);
      const feeUsdc = (Number(feeMicro) / 1_000_000).toFixed(2);
      const netUsdc = (Number(totalMicro) / 1_000_000).toFixed(2);

      const template = orderCompletedTemplate({
        orderId,
        itemName: (product?.name as string) || "Order item",
        amountUsdc,
        feeUsdc,
        netUsdc,
        txHash: (orderRow?.on_chain_tx_hash as string) || null,
        explorerUrl: process.env.ARC_EXPLORER_URL || "https://testnet.arcscan.app/tx/",
        appUrl: process.env.NEXT_PUBLIC_APP_URL || "https://slimemarket.app",
      });
      await notifyUser(sellerId, {
        icon: "check-check", tone: "emerald", title: "Funds Released",
        text: `Order ${orderId.slice(0, 8)} was confirmed — your payout has been released to your earnings.`,
        link: "seller", email: template,
      });
    }
  } catch { /* non-blocking */ }
}

/** PENDING/PROCESS→CANCELLED. Buyer. Refund full.
 *
 * Non-custodial mode (ONCHAIN_FUNDS_ENABLED): DO NOT call credit_wallet_atomic.
 * Just update order status to CANCELLED with on_chain_status=refund_pending.
 * Skip phantom ledger entries — in non-custodial mode, funds never touched
 * custodial wallet anyway; buyer paid directly to MarketEscrow contract.
 */
export async function cancelOrder(orderId: string, user: CurrentUser, reason: string) {
  const admin = supabaseAdminClient();

  // (b) Preflight guard: clean 409 instead of a cryptic RPC raise.
  const { data: pre } = await admin.from("orders")
    .select("status, amount").eq("id", orderId).maybeSingle();
  if (!pre) throw new Error("order not found");
  guardTransition(pre.status as string, ["PENDING", "PROCESS"], "cancel");

  if (ONCHAIN_FUNDS_ENABLED) {
    // NON-CUSTODIAL MODE: No credit_wallet_atomic needed. Funds were locked
    // directly in MarketEscrow by buyer. Just flip status to CANCELLED.
    const { error } = await admin.from("orders").update({
      status: "CANCELLED",
      cancel_reason: reason,
    }).eq("id", orderId);
    if (error) throw new Error(error.message);

    // Mark on-chain refund as pending for reconciliation
    await admin.from("orders").update({
      on_chain_status: "refund_pending",
      on_chain_last_attempt_at: new Date().toISOString(),
    }).eq("id", orderId);

    // Record REFUNDED lifecycle event (audit trail only, no ledger impact)
    await recordLifecycleEvent(
      admin as unknown as Parameters<typeof recordLifecycleEvent>[0],
      {
        orderId,
        operation: "REFUNDED",
        txHash: null,
        amountMicro: parseAmountOrZero(pre.amount as string | null),
        note: `buyer-cancel (non-custodial): ${reason}`,
      },
      { triggeredBy: user.id },
    );
  } else {
    // CUSTODIAL MODE: Use atomic refund that includes credit_wallet_atomic
    const { error } = await admin.rpc("cancel_order_atomic", {
      p_order_id: orderId, p_actor_id: user.id, p_reason: reason,
    });
    if (error) throw new Error(error.message);

    // (c) REFUNDED lifecycle row (custodial mode includes ledger credits).
    await recordLifecycleEvent(
      admin as unknown as Parameters<typeof recordLifecycleEvent>[0],
      {
        orderId,
        operation: "REFUNDED",
        txHash: null,
        amountMicro: parseAmountOrZero(pre.amount as string | null),
        note: `buyer-cancel: ${reason}`,
      },
      { triggeredBy: user.id },
    );
  }

  if (isContractReady()) {
    const { data: orderRow } = await admin.from("orders")
      .select("on_chain_order_id").eq("id", orderId).maybeSingle();
    const onChainId = orderRow?.on_chain_order_id as string | null;
    if (onChainId) {
      try {
        const result = await refundOrderOnChain(onChainId, PLATFORM_WALLET_ID);
        // (a) On-chain refund tx submitted — DB mirror failure must not fail
        // the cancel; reconcile cron backstops.
        await bestEffortPersist(
          "cancel:update-onchain-refund-pending",
          async () => {
            const { error: upErr } = await admin.from("orders").update({
              on_chain_status: "refund_pending",
              on_chain_circle_tx_id: result?.id ?? null,
              on_chain_last_attempt_at: new Date().toISOString(),
            }).eq("id", orderId);
            if (upErr) throw new Error(upErr.message);
          },
          { logger, context: { orderId, onChainId } },
        );
        await createMmAuditLog({
          mmUserId: null, mmWalletId: PLATFORM_WALLET_ID,
          actorType: "platform",
          action: "REFUND_ORDER", refId: orderId,
          circleTxId: result?.id,
          detail: { reason, triggeredBy: user.id, type: "buyer-cancel", onChainOrderId: onChainId },
        });
      } catch (e) {
        // P0-10 FIX: Track failure in DB columns so the reconcile cron can retry.
        const errMsg = (e as Error).message;
        console.error(`[on-chain] refundOrder failed for order ${orderId} (buyer-cancel):`, e);
        await admin.from("orders").update({
          on_chain_status: "refund_failed",
          on_chain_error: errMsg,
          on_chain_retry_count: 0,
          on_chain_last_attempt_at: new Date().toISOString(),
        }).eq("id", orderId);
        await createMmAuditLog({
          mmUserId: null, mmWalletId: PLATFORM_WALLET_ID,
          actorType: "platform",
          action: "REFUND_ORDER", refId: orderId,
          detail: { type: "on-chain-release-failed", error: errMsg, onChainOrderId: onChainId, triggeredBy: user.id },
        }).catch(() => {});
      }
    }
  }

  // tell the buyer their money came back. The refund is relayed
  // on-chain directly to their wallet, so without this the order just silently
  // changed status. Best-effort: never fail a completed cancel on a notification.
  await notifyUser(user.id, {
    icon: "undo-2",
    tone: "emerald",
    title: "Order Cancelled — Refund Sent",
    text: `Order ${orderId.slice(0, 8)} was cancelled. ${formatMicroForNotice(pre.amount as string | null)} USDC is on its way back to your wallet. The 2% service fee is not refundable.`,
    link: "orders",
    email: true,
  }).catch(() => {});
}

/** PENDING/PROCESS→DECLINED. Seller. Refund buyer full. */
export async function declineOrder(orderId: string, user: CurrentUser, reason: string) {
  const admin = supabaseAdminClient();

  // (b) Preflight guard: clean 409 instead of a cryptic RPC raise.
  const { data: pre } = await admin.from("orders")
    .select("status, amount").eq("id", orderId).maybeSingle();
  if (!pre) throw new Error("order not found");
  guardTransition(pre.status as string, ["PENDING", "PROCESS"], "refund");

  const { error } = await admin.rpc("decline_order_atomic", {
    p_order_id: orderId, p_actor_id: user.id, p_reason: reason,
  });
  if (error) throw new Error(error.message);

  // (c) REFUNDED lifecycle row (decline refunds the buyer in full).
  await recordLifecycleEvent(
    admin as unknown as Parameters<typeof recordLifecycleEvent>[0],
    {
      orderId,
      operation: "REFUNDED",
      txHash: null,
      amountMicro: parseAmountOrZero(pre.amount as string | null),
      note: `seller-decline: ${reason}`,
    },
    { triggeredBy: user.id },
  );

  if (isContractReady()) {
    const { data: orderRow } = await admin.from("orders")
      .select("on_chain_order_id").eq("id", orderId).maybeSingle();
    const onChainId = orderRow?.on_chain_order_id as string | null;
    if (onChainId) {
      try {
        const result = await refundOrderOnChain(onChainId, PLATFORM_WALLET_ID);
        // (a) On-chain refund tx submitted — DB mirror failure must not fail
        // the decline; reconcile cron backstops.
        await bestEffortPersist(
          "decline:update-onchain-refund-pending",
          async () => {
            const { error: upErr } = await admin.from("orders").update({
              on_chain_status: "refund_pending",
              on_chain_circle_tx_id: result?.id ?? null,
              on_chain_last_attempt_at: new Date().toISOString(),
            }).eq("id", orderId);
            if (upErr) throw new Error(upErr.message);
          },
          { logger, context: { orderId, onChainId } },
        );
        await createMmAuditLog({
          mmUserId: null, mmWalletId: PLATFORM_WALLET_ID,
          actorType: "platform",
          action: "REFUND_ORDER", refId: orderId,
          circleTxId: result?.id,
          detail: { reason, triggeredBy: user.id, type: "seller-decline", onChainOrderId: onChainId },
        });
      } catch (e) {
        // P0-10 FIX: Track failure in DB columns so the reconcile cron can retry.
        const errMsg = (e as Error).message;
        console.error(`[on-chain] refundOrder failed for order ${orderId} (seller-decline):`, e);
        await admin.from("orders").update({
          on_chain_status: "refund_failed",
          on_chain_error: errMsg,
          on_chain_retry_count: 0,
          on_chain_last_attempt_at: new Date().toISOString(),
        }).eq("id", orderId);
        await createMmAuditLog({
          mmUserId: null, mmWalletId: PLATFORM_WALLET_ID,
          actorType: "platform",
          action: "REFUND_ORDER", refId: orderId,
          detail: { type: "on-chain-release-failed", error: errMsg, onChainOrderId: onChainId, triggeredBy: user.id },
        }).catch(() => {});
      }
    }
  }

  // Notify buyer: order declined + refunded (non-blocking).
  try {
    const { data: o } = await admin.from("orders").select("buyer_id").eq("id", orderId).maybeSingle();
    if (o?.buyer_id) await notifyUser(o.buyer_id as string, {
      icon: "ban", tone: "rose", title: "Order Declined",
      text: `Your order ${orderId.slice(0, 8)} was declined by the seller (${reason}). Funds have been refunded.`,
      link: "orders", email: true,
    });
  } catch { /* non-blocking */ }
}

/** PENDING→PROCESS. Seller only. */
export async function advanceOrder(orderId: string, user: CurrentUser) {
  const admin = supabaseAdminClient();
  const { error } = await admin.rpc("advance_order", {
    p_order_id: orderId, p_actor_id: user.id,
  });
  if (error) throw new Error(error.message);
}

/** PROCESS→SENT. Seller fills credentials. Sets 42h auto-release deadline. */
export async function sendOrder(
  orderId: string, user: CurrentUser, credentials: Record<string, string>, notes: string
) {
  const admin = supabaseAdminClient();
  const now = new Date();
  const deadline = new Date(now.getTime() + RELEASE_DEADLINE_HOURS * 60 * 60 * 1000);
  const { error } = await admin.rpc("send_order", {
    // Pass the object (not a JSON string) — p_credentials is jsonb. Stringifying
    // double-encodes it, so the buyer's mapper can't parse it back to an object.
    p_order_id: orderId, p_actor_id: user.id,
    p_credentials: credentials, p_notes: notes,
  });
  if (error) throw new Error(error.message);

  await admin.from("orders")
    .update({ sent_at: now.toISOString(), release_deadline: deadline.toISOString() })
    .eq("id", orderId)
    .then((r) => { if (r.error) console.error("send_order deadline set failed:", r.error.message); });

  // Notify buyer: order shipped (non-blocking).
  try {
    const { data: o } = await admin.from("orders").select("buyer_id").eq("id", orderId).maybeSingle();
    if (o?.buyer_id) await notifyUser(o.buyer_id as string, {
      icon: "package-check", tone: "cyan", title: "Order Shipped",
      text: `Your order ${orderId.slice(0, 8)} has been delivered — open the Order Room to view it. 42h inspection window started.`,
      link: "orders", email: true,
    });
  } catch { /* non-blocking */ }
}

/** SENT→DISPUTED. Buyer only. Simple status flip (no ledger). Auto-creates mediasi thread. */
export async function appealOrder(orderId: string, user: CurrentUser, reason: string) {
  const admin = supabaseAdminClient();
  const { data: order } = await admin.from("orders")
    .select("status, buyer_id").eq("id", orderId).maybeSingle();
  if (!order || order.buyer_id !== user.id) throw new Error("not your order");
  // (b) Preflight guard: clean 409 for wrong-status appeals.
  guardTransition(order.status as string, ["SENT"], "refund");
  // Pause auto-release deadline on dispute
  const { error } = await admin.from("orders")
    .update({ status: "DISPUTED", cancel_reason: reason, release_deadline: null }).eq("id", orderId);
  if (error) throw new Error(error.message);

  // (c) DISPUTED lifecycle row (after the status flip is committed).
  await recordLifecycleEvent(
    admin as unknown as Parameters<typeof recordLifecycleEvent>[0],
    {
      orderId,
      operation: "DISPUTED",
      txHash: null,
      amountMicro: null,
      note: `buyer-appeal: ${reason}`,
    },
    { triggeredBy: user.id },
  );

  // Auto-create mediasi chat thread (buyer + seller + admins)
  try {
    const { ensureDisputeThread } = await import("./disputes");
    await ensureDisputeThread(orderId);
  } catch (e) {
    console.error("Failed to create dispute thread:", e);
  }

  // Notify seller + admin channel: order disputed (non-blocking).
  try {
    const sellerId = await sellerIdForOrder(admin, orderId);
    if (sellerId) await notifyUser(sellerId, {
      icon: "gavel", tone: "rose", title: "Order Disputed",
      text: `Order ${orderId.slice(0, 8)} was appealed by the buyer (${reason}). The Tribunal will review.`,
      link: "seller", telegram: true,
    });
  } catch { /* non-blocking */ }
}

/** Insert reviews row. DONE only, verified purchase, 1 per order. */
export async function reviewOrder(
  orderId: string, user: CurrentUser, rating: number, comment: string
) {
  if (rating < 1 || rating > 5) throw new Error("rating must be 1-5");
  const admin = supabaseAdminClient();
  const { data: order } = await admin.from("orders")
    .select("status, buyer_id, store_id").eq("id", orderId).maybeSingle();
  if (!order || order.buyer_id !== user.id) throw new Error("not your order");
  if (order.status !== "DONE") throw new Error("can only review DONE orders");
  const { error } = await admin.from("reviews").insert({
    order_id: orderId, store_id: order.store_id,
    rating, text: comment || null,
    display_name: user.name,
  });
  if (error) {
    if (error.code === "23505") throw new Error("already reviewed");
    throw new Error(error.message);
  }
}
