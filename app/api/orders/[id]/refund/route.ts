// app/api/orders/[id]/refund/route.ts
import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/utils";
import { requireAdminAuth } from "@/lib/admin-auth";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { isContractReady, refundOrderOnChain } from "@/lib/contracts/escrow-client";
import { logger } from "@/lib/logger";
import {
  processOrderRefund,
  lifecycleRecorder,
  type RefundAdmin,
} from "@/lib/order/refund";
import { httpStatusOfError } from "@/lib/order/patterns";

/**
 * POST /api/orders/[id]/refund — Admin force-refund of an order.
 *
 * Rebuilt in on the REAL on-chain refund path. The previous version
 * faked refunds (mock tx hash + nonexistent columns) and would mark orders
 * refunded WITHOUT moving funds. That is deleted.
 *
 * Real path: MarketEscrow.refundOrder(uint256) (onlyOperator) relayed via the
 * platform Circle DCW — the SAME relay cancel/decline/dispute-resolve use —
 * then the ledger/status transition (resolve_dispute_atomic, refund branch),
 * then a REFUNDED lifecycle event. Funds move FIRST; the DB never claims a
 * refund the chain hasn't accepted.
 *
 * Auth: Admin role + X-Admin-Token (PIN + UCW-verified), matching the other
 * money-moving admin routes (admin/disputes/[id]/resolve).
 *
 * Refundable statuses: DISPUTED only. Everything else → 409 (incl.
 * CANCELLED/DECLINED which were already refunded — idempotent rejection).
 *
 * Body: { reason: string }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdminAuth(req);
  if (auth.error) return auth.error;
  const { user } = auth;

  const { id: orderId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError("invalid JSON payload", 400);
  }
  const { reason } = (body ?? {}) as { reason?: string };
  if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
    return jsonError("reason is required", 400);
  }

  try {
    const result = await processOrderRefund(
      {
        admin: supabaseAdminClient() as unknown as RefundAdmin,
        isContractReady,
        refundOrderOnChain,
        recordLifecycleEvent: lifecycleRecorder,
        logger,
        platformWalletId: process.env.PLATFORM_CIRCLE_WALLET_ID ?? "",
      },
      { orderId, reason },
      user,
    );

    return jsonOk({
      ok: true,
      orderId,
      status: result.status,
      txId: result.txId,
      onChainOrderId: result.onChainOrderId,
      refunded: true,
      reason,
    });
  } catch (e) {
    const status = httpStatusOfError(e) ?? 500;
    const message = e instanceof Error ? e.message : "refund failed";
    if (status >= 500) {
      logger.error({ orderId, err: message }, "admin-refund failed");
    }
    return jsonError(message, status);
  }
}
