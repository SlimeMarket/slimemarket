import { jsonError, jsonOk } from "@/lib/utils";
import { requireAdminAuth } from "@/lib/admin-auth";
import { resolveDispute, ensureDisputeThread } from "@/lib/order/disputes";

/**
 * POST /api/admin/disputes/[id]/resolve
 *
 * Resolve a disputed marketplace order. Admin decides: refund buyer or release to seller.
 * Requires admin auth token (PIN + UCW verified).
 *
 * Body: { decision: "refund" | "release", reason: string }
 *
 * On success:
 *   - DB ledger updated (refund full / release 98-2)
 *   - On-chain contract executed (if ready)
 *   - Chat thread marked resolved
 *   - Audit log created
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminAuth(req);
  if (auth.error) return auth.error;
  const { user } = auth;

  const { id: orderId } = await params;

  let body: unknown;
  try { body = await req.json(); } catch { return jsonError("invalid JSON", 400); }
  const { decision, reason } = (body ?? {}) as { decision?: string; reason?: string };

  if (!decision || !["refund", "release"].includes(decision)) {
    return jsonError('decision must be "refund" or "release"', 400);
  }
  if (!reason) return jsonError("reason is required", 400);

  try {
    const result = await resolveDispute(orderId, user, decision as "refund" | "release", reason);
    return jsonOk({
      ok: true,
      orderId,
      decision,
      finalStatus: result.status,
      onChainExecuted: result.onChain,
      reason,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "resolve failed";
    return jsonError(msg, /not found|not DISPUTED/i.test(msg) ? 400 : 500);
  }
}
